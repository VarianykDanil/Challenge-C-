import requests
import json
import csv

# Replace with your actual access token and activity ID
ACCESS_TOKEN = 'd13a3fee0162b131e53c83df3634c43e16ccefea'  # Your Strava API access token
ACTIVITY_ID = '11986938277'  # The Strava activity ID you want to fetch data for

# Define the path to the CSV file
CSV_FILE_PATH = 'journey_data.csv'  # Path to save the CSV file

def get_strava_activity_data(activity_id, access_token):
    # Define the URL for the Strava API request
    url = f"https://www.strava.com/api/v3/activities/{activity_id}"
    # Set up the headers with the access token
    headers = {
        "Authorization": f"Bearer {access_token}"
    }
    # Make the GET request to the Strava API
    response = requests.get(url, headers=headers)
    # Parse the JSON response
    data = response.json()
    return data

def save_gps_data_to_csv(activity_data, filename):
    # Open the CSV file for writing
    with open(filename, mode='w') as file:
        writer = csv.writer(file)
        # Write the header row
        writer.writerow(["lat", "lon", "speed"])
        # Replace this with actual GPS data extraction logic
        for point in activity_data['map']['polyline']:
            writer.writerow([point['lat'], point['lon'], point['speed']])


def save_gps_data_to_csv(activity_data, csv_file_path):
    with open(csv_file_path, mode='w', newline='') as file:
        writer = csv.writer(file)
        # Write header
        writer.writerow(['Latitude', 'Longitude', 'Speed'])

        for point in activity_data:
            print(f"Debug: point = {point}")  # Debugging line
            # Ensure point is a dictionary
            if isinstance(point, dict):
                writer.writerow([point.get('lat'), point.get('lon'), point.get('speed')])
            else:
                print(f"Error: Expected dictionary but got {type(point)}")


# Fetch the activity data from Strava
activity_data = get_strava_activity_data(ACTIVITY_ID, ACCESS_TOKEN)
# Save the GPS data to the CSV file

save_gps_data_to_csv(activity_data, CSV_FILE_PATH)


activity_data = [
    {"lat": 52.5200, "lon": 13.4050, "speed": 10.5},
    {"lat": 52.5201, "lon": 13.4051, "speed": 11.0},
    # More data points...
]

