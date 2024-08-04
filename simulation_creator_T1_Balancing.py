import subprocess
import pandas as pd
import mosaik
import mosaik.util
import numpy as np
import pandas as pd
from mosaik.util import connect_many_to_one
import time
from configuration.buildmodelset import *

class simulation_creator_Balancing:
    
    def __init__(self,Defined_models):
        self.Defined_models = Defined_models # Defined models includes all used components as defined in ipynb file eg. 'PV', 'Wind', 'Load', 'Battery'
        
    # def __init__(self, day, number_houses, wind_cap, pv_cap, battery_cap, soc_initial):
    #     self.day = day
    #     self.number_houses = number_houses
    #     self.wind_cap = wind_cap
    #     self.pv_cap = pv_cap 
    #     self.battery_cap = battery_cap
    #     self.soc_initial = soc_initial
        
        
    def create_simulation(self, Battery_set, pv_panel_set, pv_set, load_set, Wind_set):
        sim_config_file = "Cases/T1_Balancing/"
        sim_config_ddf = pd.read_xml(sim_config_file + 'config.xml')
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

        connection = pd.read_xml(sim_config_file + 'connection.xml')

        #Interval : currently one specific day in 15 minute intervals, can be adjusted for other time intervals 
        START_DATE = self.day + ' 00:00:00'
        end = 1 * 24 * 3600 

        load_DATA = 'Scenarios/load_data.txt' # Default load data for a year for one household
        Wind_DATA = 'Scenarios/winddata_NL.txt' #windspeed data one year
        Pv_DATA = 'Scenarios/pv_data_Rotterdam_NL-15min.txt' # location specific data for PV model (one year)
        
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
        ctrl = ctrlsim.Ctrl(sim_start=START_DATE, soc_min=Battery_set['soc_min'], soc_max=Battery_set['soc_max'])
        
        #need to adapt especially outputfile!!!
        RESULTS_SHOW_TYPE={'write2csv':True, 'dashboard_show':False, 'Finalresults_show':True,'database':False,'mqtt':False}
        collector = world.start('Collector', start_date=START_DATE, results_show=RESULTS_SHOW_TYPE, output_file=outputfile)
        monitor = collector.Monitor()
        
        for model_i in self.Defined_models.iterrows():
            if model_i[1]['model'] == 'PV':
                solardata = world.start('CSVB', sim_start=START_DATE, datafile=Pv_DATA)  # loading the data file to mosaik
                pvsim = world.start('PV') 
                pv = pvsim.PVset.create(model_i[1]['number'], sim_start=START_DATE, panel_data=pv_panel_set,
                                        m_tilt=pv_set['m_tilt'], m_az=pv_set['m_az'], cap=pv_set['cap'],
                                        output_type=pv_set['output_type'])  # cap in W
                solarprofile_data = solardata.Solar_data.create(model_i[1]['number'])  # instantiating an entity of the solar data file
                for i in range(model_i[1]['number']):
                    world.connect(solarprofile_data[i], pv[i], 'G_Gh', 'G_Dh', 'G_Bn', 'Ta', 'hs', 'FF', 'Az')
            elif model_i[1]['model'] == 'Wind':
                WSdata = world.start('CSVB', sim_start=START_DATE, datafile=Wind_DATA)  # loading the data file to mosaik
                windsim = world.start('Wind')  # the name you gave to the in sim_config above
                wind = windsim.windmodel.create(model_i[1]['number'], sim_start=START_DATE,
                                                p_rated=Wind_set['p_rated'], u_rated=Wind_set['u_rated'],
                                                u_cutin=Wind_set['u_cutin'], u_cutout=Wind_set['u_cutout'],
                                                cp=Wind_set['cp'], diameter=Wind_set['diameter'],
                                                output_type=Wind_set['output_type'])  # p_rated in kW  #Resolution here is in minutes
                ## print(wind.full_id)
                windspeed_data = WSdata.WS_datafile.create(model_i[1]['number'])  # instantiating an entity of the wind data file
                for i in range(model_i[1]['number']):
                    world.connect(windspeed_data[i], wind[i], 'u')

            elif model_i[1]['model'] == 'Load':
                loaddata = world.start('CSVB', sim_start=START_DATE, datafile=load_DATA)  # loading the data file to mosaik
                loadsim = world.start('Load')  # the name you gave to the in sim_config above
                load = loadsim.loadmodel.create(model_i[1]['number'], sim_start=START_DATE,
                                                houses=load_set['houses'], output_type=load_set['output_type'])  # loadmodel is the name we gave in the mosaik API file while writing META
                load_data = loaddata.Load_data.create(model_i[1]['number'])  # Load_data is the header in the txt file containing the load values.
                for i in range(model_i[1]['number']):
                    world.connect(load_data[i], load[i], 'load')
            elif model_i[1]['model'] == 'Battery':
                #### no battery input data file as the input 'p_ask' comes from the controller. We connect the controller and the battery ahead.

                batterysim = world.start('Battery')  # the name you gave to the in sim_config above

                battery = batterysim.Batteryset(sim_start=START_DATE, initial_set=Battery_initialset,
                                                battery_set=Battery_set)
        
        
        return

