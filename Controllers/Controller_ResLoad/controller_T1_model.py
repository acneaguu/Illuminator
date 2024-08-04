class Controller_ResLoad:
    
    # make adaptable with different combinations of RES generation and 
    def __init__(self, load, pv_model, wind_model, battery_model = None):
        
        self.load = load
        self.pv_model = pv_model
        self.wind_model = wind_model
        
        if battery_model != None:
            self.soc_max_b = battery_model.soc_max
            self.soc_min_b = battery_model.soc_min

            self.dump = 0 # check if needed -> maybe later
            self.flow_b = 0 # flow_b is the flow to the battery so negative when discharge, positive when charge

        
    def control(self, soc , pv_gen, load_dem, wind_gen):

        self.soc_b = soc
        residual_load = load_dem - wind_gen + pv_gen # kW

        if self.battery_model != None:
            if residual_load > 0:  
                # demand not satisfied -> discharge battery if possible
                if self.soc_b > self.soc_min_b:  # checking if soc is above minimum
                    print('Discharge Battery')
                    self.flow_b = -min(residual_load, self.soc_b-self.soc_min_b)
                          
            elif residual_load < 0:
            
                if self.soc_b < self.soc_max_b:
                    print('Charge Battery')
                    self.flow_b = min((-residual_load), self.soc_max_b-self.soc_b)
                
                    print('Excess generation that cannot be stored: ' + str(residual_load-self.flow_b))

            else:
                print('No Residual Load, RES production completely covers demand')
                self.flow_b = 0
                #demand_res = residual_load

            #demand_res = residual_load + self.flow_b
        
        return self.flow_b, residual_load 