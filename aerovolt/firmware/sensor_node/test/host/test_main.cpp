// Entry point of the avcore host unit tests: runs every TEST() registered in test_*.cpp.
#include "check.h"

int main() { return check::run_all_tests(); }
