class Controller_ResLoad:
    
    # make adaptable with different combinations of RES generation and 
    def __init__(self, soc_min = None,soc_max = None):
        
        if soc_min != None and soc_max != None:
            self.soc_max_b = soc_max
            self.soc_min_b = soc_min

            self.dump = 0 # check if needed -> maybe later
            self.flow_b = 0 # flow_b is the flow to the battery so negative when discharge, positive when charge

        
    def control(self, wind_gen, pv_gen, load_dem, soc = None):

        self.soc_b = soc
        res_load = load_dem - wind_gen + pv_gen # kW

        if self.soc_max_b != None:
            if res_load > 0:
                # demand not satisfied -> discharge battery if possible
                if self.soc_b > self.soc_min_b:  # checking if soc is above minimum
                    print('Discharge Battery')
                    self.flow_b = -min(res_load, self.soc_b-self.soc_min_b)
                          
            elif res_load < 0:
            
                if self.soc_b < self.soc_max_b:
                    print('Charge Battery')
                    self.flow_b = min((-res_load), self.soc_max_b-self.soc_b)
                
                    print('Excess generation that cannot be stored: ' + str(res_load-self.flow_b))

            else:
                print('No Residual Load, RES production completely covers demand')
                self.flow_b = 0
                #demand_res = residual_load

            #demand_res = residual_load + self.flow_b
        print('residual load: ' + str(res_load))
        print('battery flow: ' + str(self.flow_b))
        if soc_min != None:
            return res_load, self.flow_b
        else:
            return res_load