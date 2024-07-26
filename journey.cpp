#include <iostream>    // For input/output operations
#include <fstream>     // For file operations
#include <vector>      // For using the vector container
#include <sstream>     // For string stream operations
#include <cmath>       // For mathematical functions
#include <iomanip>     // For setting output format

// Define a structure to store GPS points with latitude, longitude, and speed
struct Point {
    double lat;    // Latitude
    double lon;    // Longitude
    double speed;  // Speed
};

// Define a class to handle journey-related operations
class Journey {
public:
    // Method to add a point to the journey
    void add_point(double lat, double lon, double speed) {
        points.push_back({lat, lon, speed});
    }

    // Method to read journey data from a CSV file
    void read_from_csv(const std::string& filename) {
        std::ifstream file(filename);    // Open the file
        std::string line, token;
        // Skip the header row
        std::getline(file, line);
        // Read each line from the file
        while (std::getline(file, line)) {
            std::stringstream ss(line);
            std::vector<std::string> row;
            // Split the line by commas
            while (std::getline(ss, token, ',')) {
                row.push_back(token);
            }
            // If the row has exactly 3 elements, add it as a point
            if (row.size() == 3) {
                add_point(std::stod(row[0]), std::stod(row[1]), std::stod(row[2]));
            }
        }
    }

    // Method to print the journey data
    void print_journey() {
        for (const auto& point : points) {
            std::cout << std::fixed << std::setprecision(6) 
                      << "Lat: " << point.lat 
                      << ", Lon: " << point.lon 
                      << ", Speed: " << point.speed 
                      << " m/s" << std::endl;
        }
    }

    // Method to calculate the total journey distance using the Haversine formula
    double calculate_distance() {
        double total_distance = 0.0;
        // Loop through the points to calculate the distance between consecutive points
        for (size_t i = 1; i < points.size(); ++i) {
            total_distance += haversine(points[i-1], points[i]);
        }
        return total_distance;
    }

private:
    std::vector<Point> points;    // Vector to store the points

    // Haversine formula to calculate the distance between two GPS points
    double haversine(const Point& p1, const Point& p2) {
        const double R = 6371e3;    // Earth radius in meters
        double lat1 = p1.lat * M_PI / 180.0;
        double lat2 = p2.lat * M_PI / 180.0;
        double dlat = (p2.lat - p1.lat) * M_PI / 180.0;
        double dlon = (p2.lon - p1.lon) * M_PI / 180.0;
        double a = std::sin(dlat / 2) * std::sin(dlat / 2) +
                   std::cos(lat1) * std::cos(lat2) *
                   std::sin(dlon / 2) * std::sin(dlon / 2);
        double c = 2 * std::atan2(std::sqrt(a), std::sqrt(1 - a));
        return R * c;
    }
};

int main() {
    Journey journey;    // Create a Journey object
    std::string csv_file_path = "journey_data.csv";    // Define the path to the CSV file
    journey.read_from_csv(csv_file_path);    // Read data from the CSV file
    journey.print_journey();    // Print the journey data
    double distance = journey.calculate_distance();    // Calculate the total journey distance
    std::cout << "Total journey distance: " << distance << " meters" << std::endl;
    return 0;
}
