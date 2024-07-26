# Use an official image for C++ development
FROM gcc:latest

# Set the working directory
WORKDIR /usr/src/app

# Copy the current directory contents into the container at /usr/src/app
COPY . .

# Update and install Python, pip, and virtualenv
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv

# Create a virtual environment
RUN python3 -m venv venv

# Activate the virtual environment and install the requests library
RUN . venv/bin/activate && pip install requests

# Command to run your Python script and compile & run your C++ code
CMD . venv/bin/activate && python fetch_strava_data.py && g++ -o journey journey.cpp && ./journey
