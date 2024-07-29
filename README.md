Strava Journey Analyzer
====
This project fetches GPS data from Strava and analyzes the journey details using both Python and C++. It calculates journey statistics such as total distance traveled using the Haversine formula.
Prerequisites

Before you start, ensure you have the following:

  Docker: Installed on your machine. Install Docker
  Strava Account: Create an account if you don't have one. Sign up for Strava
  Strava API Application: Create an application to obtain your Client ID and Client Secret. Create a Strava API Application
  Access Token: Obtain an access token by authorizing your application. How to get an access token

Getting Started
Step 1: Clone the Repository
--

    mkdir strava_journey_analyzer
    cd strava_journey_analyzer
    git clone https://github.com/your-username/strava_journey_analyzer.git


Step 2: Set Up Your Environment Variables
-

Create a file named .env in the project root directory and add your Strava Access Token and Activity ID:


    STRAVA_ACCESS_TOKEN=your_strava_access_token
    STRAVA_ACTIVITY_ID=your_activity_id

Step 3: Build and Run the Docker Container
-

Build the Docker image:



    docker build -t journey-app .

Run the Docker container:



    docker run --rm journey-app

Project Structure
==

  fetch_strava_data.py: A Python script to fetch GPS data from Strava and save it to a CSV file.
  journey.cpp: A C++ program to read the CSV file, print the journey details, and calculate the total journey distance.
  Dockerfile: A file to create a Docker image that sets up the environment and runs the Python script and C++ program.
  .env: A file to store environment variables (e.g., Strava access token and activity ID).

Detailed Steps
-
1. Strava API Setup
   -

    Create a Strava API Application:
        Go to the Strava API settings page and create a new application.
        Note down your Client ID and Client Secret.

    Obtain an Access Token:
        Follow the Strava API OAuth tutorial to authorize your application and obtain an access token.
        Replace your_strava_access_token in the .env file with your actual access token.

    Get an Activity ID:
        Log into Strava and find an activity you want to analyze.
        Note down the activity ID from the URL (e.g., https://www.strava.com/activities/123456789).

2. Python Script (fetch_strava_data.py)
   --
   This script fetches GPS data from Strava and saves it to a CSV file named journey_data.csv.

3. C++ Program (journey.cpp)
   --

   This program reads the CSV file, prints the journey details, and calculates the total journey distance using the Haversine formula.
4. Docker Setup
   --

    The Dockerfile sets up the environment, installs dependencies, runs the Python script to fetch data, and then compiles and runs the C++ program.
5. Authorize the Application:
   --

    Generate an authorization URL:
          https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost&scope=activity:read_all

    Replace YOUR_CLIENT_ID with your actual Client ID.
    Navigate to this URL, authorize the app, and get the authorization code.
6. Exchange Authorization Code for Access Token:
   --
    Use the following curl command to exchange the authorization code for an access token:

        curl -X POST https://www.strava.com/oauth/token \
          -F client_id=YOUR_CLIENT_ID \
          -F client_secret=YOUR_CLIENT_SECRET \
          -F code=AUTHORIZATION_CODE \
          -F grant_type=authorization_code

    Replace YOUR_CLIENT_ID, YOUR_CLIENT_SECRET, and AUTHORIZATION_CODE with your actual values.
    Note down the access token from the response.
   
By following these steps, you'll be able to fetch GPS data from Strava, analyze it, and calculate the journey distance using Docker, Python, and C++. This guide is meant to help you set up and run the project seamlessly. If you encounter any issues, please refer to the Strava API documentation or Docker documentation for additional help.
--
