import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime

# Function to plot Load profile of a specific day to visualize results
def plot_load_profile(load_df, day_of_year):
    
    start_time = datetime.strptime(day_of_year, "%Y-%m-%d")
    
    end_time = start_time.replace(hour=23, minute=45, second=00)

    load_doy = load_df.loc[start_time : end_time]
    
    plt.plot(load_doy.index, load_doy['load'])
    plt.title(f'Load Profile for {day_of_year}')
    plt.xlabel('Time')
    plt.ylabel('Load')
    plt.grid(True)
    plt.xticks(rotation=45)
    plt.tight_layout()
    plt.show()
    
    return
