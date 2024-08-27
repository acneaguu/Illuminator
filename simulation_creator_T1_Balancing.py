import subprocess
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import mosaik
import mosaik.util
import numpy as np
import pandas as pd
from IPython.display import display
from mosaik.util import connect_many_to_one
import time
from datetime import datetime
from configuration.buildmodelset import *

class simulation_creator_Balancing:
    
    def __init__(self,components,day_of_year = "2012-06-01", number_of_houses = 1, pv_inputs = None, 
                          wind_inputs = None, battery_inputs = None):
        self.day_of_year = day_of_year
        self.Defined_models = pd.DataFrame()
        self.Defined_models['model'] = components # Defined models includes all used components as defined in ipynb file eg. 'PV', 'Wind', 'Load', 'Battery'

        #self.results_summary = pd.DataFrame() # Dataframe with ResLoad, Load, RES Gen, Battery SOC, Battery Flow
        
        self.create_simulation(day_of_year, number_of_houses, pv_inputs, 
                          wind_inputs, battery_inputs)
        #maybe move parts to initialization function
    def create_simulation(self, day_of_year, number_of_houses, pv_inputs, 
                          wind_inputs, battery_inputs):
        
        sim_config_file = "Cases/T1_Balancing/"
        if 'Battery' in self.Defined_models['model'].values:
            sim_config_ddf = pd.read_xml('../Cases/T1_Balancing/config_wBat.xml')
            battery_active = 1
            self.outputfile = '../Notebooks/results_T1_Res_Bat.csv'
            #sim_config_ddf = pd.read_xml(sim_config_file + 'config_wBat.xml')
        else:
            #sim_config_ddf = pd.read_xml(sim_config_file + 'config.xml')
            sim_config_ddf = pd.read_xml('../Cases/T1_Balancing/config.xml')
            battery_active = 0
            print('battery not active')
            self.outputfile = '../Notebooks/results_T1_Res.csv'

        sim_config = {row[1]: {row[2]: row[3]} for row in sim_config_ddf.values}

        tosh = sim_config_ddf[sim_config_ddf['method'] == 'connect']
        # ! /usr/bin/env python
        if not tosh.empty:
            with open('run.sh', 'w') as rsh:
                rsh.write("#! /bin/bash")
                for row in tosh.values:
                    rsh.write("\n" + "lxterminal -e ssh illuminator@" + row[3].replace(':5123', ' ') +
                      "'./Desktop/Illuminator/configuration/runshfile/run" + row[1] + ".sh'&")

            subprocess.run(['/bin/bash', '/home/illuminator/Desktop/Illuminator/configuration/run.sh'])

        if battery_active == 1:
            connection = pd.read_xml('../' + sim_config_file + '\connection_wBat.xml')
        else:
            connection = pd.read_xml('../' + sim_config_file + '\connection.xml')

        #Interval : currently one specific day in 15 minute intervals, can be adjusted for other time intervals 
        START_DATE = self.day_of_year + ' 00:00:00'#datetime.strptime(self.day_of_year, "%Y-%m-%d")
        end = 1 * 24 * 3600 

        load_DATA = '../Scenarios/load_data.txt' # Default load data for a year for one household
        Wind_DATA = '../Scenarios/winddata_NL.txt' #windspeed data one year
        Pv_DATA = '../Scenarios/pv_data_Rotterdam_NL-15min.txt' # location specific data for PV model (one year)
        
        #other inputs defaults
        pv_panel_set ={'Module_area': 1.26, 'NOCT': 44, 'Module_Efficiency': 0.198, 'Irradiance_at_NOCT': 800,  #panel specs -> maybe adjust so number of modules can be changed
          'Power_output_at_STC': 250,'peak_power':600}
        pv_set={'m_tilt':14,'m_az':180,'cap':500,'output_type':'power'}
        
        #update inputs if given
        #PV
        pv_panel_updates = {key: pv_inputs[key] for key in pv_inputs if key in pv_panel_set}
        pv_panel_set.update(pv_panel_updates)
        pv_set_updates = {key: pv_inputs[key] for key in pv_inputs if key in pv_set}
        pv_set.update(pv_set_updates)

        #Load
        load_set={'houses': number_of_houses, 'output_type':'power'} 

        #Wind
        Wind_set={'p_rated':300, 'u_rated':10.3, 'u_cutin':2.8, 'u_cutout':25, 'cp':0.40, 'diameter':22, 
                  'output_type':'power'} #wind specs
        wind_set_updates = {key: wind_inputs[key] for key in wind_inputs if key in Wind_set}
        Wind_set.update(wind_set_updates)

        #Battery
        if battery_active == 1:
            Battery_initialset = {'initial_soc': 20} # combine to battery set
            Battery_set = {'max_p': 800, 'min_p': -800, 'max_energy': 800,
            'charge_efficiency': 0.9, 'discharge_efficiency': 0.9,
            'soc_min': 10, 'soc_max': 90, 'flag': 0,'resolution':15}
        
            battery_initialset_updates = {key: battery_inputs[key] for key in battery_inputs if key in Battery_initialset}
            Battery_initialset.update(battery_initialset_updates)
            battery_set_updates = {key: battery_inputs[key] for key in battery_inputs if key in Battery_set}
            Battery_set.update(battery_set_updates)
        
        
        #set up world for scenario
        #Note sim_config now set for all components active -> how to adjust?
        world = mosaik.World(sim_config, debug=True)
        
        models = pd.concat([connection["send"], connection["receive"]])
        models = models.drop_duplicates(keep='first', inplace=False)
        models.reset_index(drop=True, inplace=True)

        number = []
        for model in self.Defined_models['model']:
            number.append(
                int((models.str.startswith(model.lower()) == True).sum())
            )
        self.Defined_models['number'] = number

        ctrlsim = world.start('Controller')
        if battery_active == 1:
            ctrl = ctrlsim.Ctrl(sim_start=START_DATE, soc_min=Battery_set['soc_min'],
                            soc_max=Battery_set['soc_max'])  # error
        else:
            ctrl = ctrlsim.Ctrl(sim_start=START_DATE)

        # need to adapt especially outputfile!!!
        RESULTS_SHOW_TYPE = {'write2csv': True, 'dashboard_show': False, 'Finalresults_show': False, 'database': False,
                             'mqtt': False}
        collector = world.start('Collector', start_date=START_DATE, results_show=RESULTS_SHOW_TYPE,
                                output_file=self.outputfile)
        monitor = collector.Monitor()

        # create simulations for different models
        for model_i in self.Defined_models.iterrows():
            if model_i[1]['model'] == 'PV':
                solardata = world.start('CSVB', sim_start=START_DATE,
                                        datafile=Pv_DATA)  # loading the data file to mosaik
                pvsim = world.start('PV')
                pv = pvsim.PVset.create(model_i[1]['number'], sim_start=START_DATE, panel_data=pv_panel_set,
                                        m_tilt=pv_set['m_tilt'], m_az=pv_set['m_az'], cap=pv_set['cap'],
                                        output_type=pv_set['output_type'])  # cap in W
                solarprofile_data = solardata.Solar_data.create(
                    model_i[1]['number'])  # instantiating an entity of the solar data file
                for i in range(model_i[1]['number']):
                    world.connect(solarprofile_data[i], pv[i], 'G_Gh', 'G_Dh', 'G_Bn', 'Ta', 'hs', 'FF', 'Az')
            elif model_i[1]['model'] == 'Wind':
                WSdata = world.start('CSVB', sim_start=START_DATE,
                                     datafile=Wind_DATA)  # loading the data file to mosaik
                windsim = world.start('Wind')  # the name you gave to the in sim_config above
                wind = windsim.windmodel.create(model_i[1]['number'], sim_start=START_DATE,
                                                p_rated=Wind_set['p_rated'], u_rated=Wind_set['u_rated'],
                                                u_cutin=Wind_set['u_cutin'], u_cutout=Wind_set['u_cutout'],
                                                cp=Wind_set['cp'], diameter=Wind_set['diameter'],
                                                output_type=Wind_set['output_type'])
                ## print(wind.full_id)
                windspeed_data = WSdata.WS_datafile.create(
                    model_i[1]['number'])  # instantiating an entity of the wind data file
                for i in range(model_i[1]['number']):
                    world.connect(windspeed_data[i], wind[i], 'u')

            elif model_i[1]['model'] == 'Load':
                loaddata = world.start('CSVB', sim_start=START_DATE,
                                       datafile=load_DATA)  # loading the data file to mosaik
                loadsim = world.start('Load')
                load = loadsim.loadmodel.create(model_i[1]['number'], sim_start=START_DATE,
                                                houses=load_set['houses'], output_type=load_set[
                        'output_type'])  # loadmodel is the name we gave in the mosaik API file while writing META
                load_data = loaddata.Load_data.create(
                    model_i[1]['number'])  # Load_data is the header in the txt file containing the load values.
                for i in range(model_i[1]['number']):
                    world.connect(load_data[i], load[i], 'load')
            elif model_i[1]['model'] == 'Battery':
                batterysim = world.start('Battery')
                battery = batterysim.Batteryset(sim_start=START_DATE, initial_set=Battery_initialset,
                                                battery_set=Battery_set)

        for i, row in connection.iterrows():
            try:
                row['more']
            except KeyError:
                world.connect(eval(row['send']), eval(row['receive']), (row['messages'], row['messager']))
            else:
                if row['more'] == 'async_requests=True':
                    # world.connect(eval(row['send']),eval(row['receive']),(row['messages'],row['messager']),
                    #               time_shifted=True, initial_data={row['messages']: 0})
                    world.connect(eval(row['send']), eval(row['receive']), (row['messages'], row['messager']),
                                  async_requests=True)
                else:
                    world.connect(eval(row['send']), eval(row['receive']), (row['messages'], row['messager']))
        if realtimefactor == 0:
            world.run(until=end)
        else:
            world.run(until=end, rt_factor=realtimefactor)
        
        return
    
    def summarize_results(self):
        #residual load plot
        day_of_year = datetime.strptime(self.day_of_year, '%Y-%m-%d')
        result_pd_df = pd.read_csv(self.outputfile, index_col=0)
        result_pd_df.index = pd.to_datetime(result_pd_df.index)
        fig, ax = plt.subplots(figsize=(10, 6))
        ax.plot(result_pd_df.index, result_pd_df['Controller-0.ctrl_0-res_load'],
                color='blue', linestyle='-', marker='o', markersize=4, linewidth=2, label='Residual Load')
        ax.plot(result_pd_df.index, result_pd_df['Load-0.load_0-load_dem'],
                color='red', linestyle='--', marker='x', markersize=4, linewidth=2, label='Load Demand')
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%H:%M'))
        ax.xaxis.set_major_locator(mdates.HourLocator(interval=1))  # Show every hour
        ax.xaxis.set_minor_locator(mdates.MinuteLocator(interval=15))  # Minor ticks every 15 minutes
        ax.set_title(f'Residual Load {day_of_year.strftime("%d-%m-%Y")}', fontsize=16)
        ax.set_xlabel('Time', fontsize=14)
        ax.set_ylabel('Load (kW)', fontsize=14)
        plt.xticks(rotation=45, ha='right')
        ax.grid(True, which='both', linestyle='--', linewidth=0.5)
        ax.legend(loc='upper right', fontsize=12)
        plt.tight_layout()
        plt.show()

        # table with averages for each hour -> adjust so that interesting variable only
        results_hourly_avg = result_pd_df.resample('H').sum()

        styled_df = results_hourly_avg.style.set_properties(**{
            'background-color': '#f9f9f9',
            'border-color': 'black',
            'border-width': '1px',
            'border-style': 'solid',
            'color': 'black',
            'font-family': 'Arial',
            'text-align': 'center'
        }).set_caption("Hourly Simulation results")

        display(styled_df)
        
        return 

