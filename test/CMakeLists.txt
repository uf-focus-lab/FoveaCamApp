# =============================================================================
# Build Recipe For Node.js core Addon Module
# =============================================================================
# License: MIT
# Author: Yuxuan Zhang (zhangyuxuan@ufl.edu)
# =============================================================================
cmake_minimum_required(VERSION 3.10)
project(tests)
set(PROJECT_HOME ${CMAKE_CURRENT_SOURCE_DIR})

# CMake Parameters and Variables
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_BUILD_TYPE Debug)

set(SRC_DIR ${PROJECT_HOME})
# Get all the cpp files in the src directory
file(GLOB SRCS ${SRC_DIR}/*.cpp ${SRC_DIR}/**/*.cpp)
# fw-sim/ is a MULTI-file target (fovea-fw-sim, declared below), not part of
# the one-executable-per-file convention.
list(FILTER SRCS EXCLUDE REGEX "/fw-sim/")

# set(CMAKE_CXX_FLAGS "-Wall -Wno-ignored-qualifiers")
set(CMAKE_CXX_FLAGS_DEBUG "-g -DDEBUG")
set(CMAKE_CXX_FLAGS_RELEASE "-O3")

# header files and libraries
include_directories(
  ${PROJECT_HOME}/../lib/ # Shared lib
)

# Project Local Library
file(GLOB SHARED_LIB_SRCS ${PROJECT_HOME}/../lib/**/*.cpp)

# Build Targets
foreach(SRC ${SRCS})
  get_filename_component(TEST_NAME ${SRC} NAME_WE)
  add_executable(${TEST_NAME} ${SRC} ${SHARED_LIB_SRCS})
endforeach()

# ------------------------------------------------------------------------------
# fovea-fw-sim — firmware-in-the-loop simulator: the REAL firmware translation
# units compiled for the host behind the thin HAL shim in fw-sim/shim
# (Arduino/core_pins stand-ins). Firmware.cpp is NOT compiled — the sim's
# main.cpp provides the pump + a verbatim copy of its dispatch switch.
# Exceptions stay ON (host default): lib/crash.h's CRASH throws like it does
# in core; the firmware's extern crash() is declared by the shim <Arduino.h>
# and defined by firmware/src/Global.cpp. FOVEA_HOST_SIM gates the single
# host seam (the ARM `bkpt` in firmware/src/Protocol.cpp); PlatformIO never
# defines it, so the MCU build is unchanged.
# ------------------------------------------------------------------------------
set(FW_DIR ${PROJECT_HOME}/../firmware)
add_executable(fovea-fw-sim
  ${PROJECT_HOME}/fw-sim/main.cpp
  ${PROJECT_HOME}/fw-sim/hal.cpp
  ${FW_DIR}/src/Protocol.cpp
  ${FW_DIR}/src/Streams.cpp
  ${FW_DIR}/src/Capture.cpp
  ${FW_DIR}/src/Trajectory.cpp
  ${FW_DIR}/src/Global.cpp
  ${FW_DIR}/src/MEMS.cpp
  ${SHARED_LIB_SRCS}
)
target_include_directories(fovea-fw-sim BEFORE PRIVATE
  ${PROJECT_HOME}/fw-sim/shim
  ${FW_DIR}/include
)
target_compile_definitions(fovea-fw-sim PRIVATE FOVEA_HOST_SIM)
if(NOT APPLE)
  # openpty lives in libutil on Linux; it is in libc on macOS (<util.h>).
  target_link_libraries(fovea-fw-sim util)
endif()
