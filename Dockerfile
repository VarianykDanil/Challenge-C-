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

# Install necessary Python libraries inside the virtual environment
RUN venv/bin/pip install requests polyline

# Compile the C++ code
RUN g++ -o journey journey.cpp

# Command to run your Python script and execute the compiled C++ program
CMD . venv/bin/activate && python fetch_strava_data.py && ./journey
