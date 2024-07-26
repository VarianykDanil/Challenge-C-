import requests
import csv
import json
import polyline as pl


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

def save_gps_data_to_csv(activity_data, csv_file_path):
    with open(csv_file_path, mode='w', newline='') as file:
        writer = csv.writer(file)
        # Write header
        writer.writerow(['Latitude', 'Longitude', 'Speed'])
        
        # Ensure the data structure
        if 'map' in activity_data and 'polyline' in activity_data['map']:
            # Example placeholder for decoding polyline, replace this with actual logic
            # This is just a sample; you need to use a polyline decoding library or logic.
            polyline = activity_data['map']['polyline']
            # Decode polyline or handle according to your data structure
            points = decode_polyline(polyline)  # You need to implement decode_polyline
            for point in points:
                writer.writerow([point['lat'], point['lon'], point['speed']])
        else:
            print("Error: 'map' or 'polyline' not found in activity data")

def decode_polyline(polyline):
    # Placeholder for polyline decoding logic
    # This function should decode the polyline and return a list of dictionaries with 'lat', 'lon', and 'speed'
    # Implement your polyline decoding logic here
    # For example, use a library like polyline for decoding

    decoded = pl.decode(polyline)
    return [{'lat': p[0], 'lon': p[1], 'speed': 0} for p in decoded]  # 'speed' needs proper handling

# Fetch the activity data from Strava
activity_data = get_strava_activity_data(ACTIVITY_ID, ACCESS_TOKEN)
# Save the GPS data to the CSV file
save_gps_data_to_csv(activity_data, CSV_FILE_PATH)
