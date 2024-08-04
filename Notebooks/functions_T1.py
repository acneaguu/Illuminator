import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime

# Function to plot Load profile of a specific day to visualize results
def plot_load_profile(load_df, day_of_year):
    date_format = "%Y-%m-%d %H:%M:%S"
    
    date_start = datetime.strptime(day_of_year + " 00:00:00", date_format)
    date_end = datetime.strptime(day_of_year + " 23:45:00", date_format)
    
    load_doy = load_df.loc[date_start: date_end]
    
    plt.plot(load_doy.index, load_doy['load'])
    plt.title(f'Load Profile for {day_of_year}')
    plt.xlabel('Time')
    plt.ylabel('Load')
    plt.grid(True)
    plt.xticks(rotation=45)
    plt.tight_layout()
    plt.show()
    
    return

