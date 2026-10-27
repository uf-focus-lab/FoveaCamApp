// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
// Link-time guard for core/lib/Aravis/Conversions.cpp: every string<->enum
// convert<> the addon uses is referenced here, so a missing specialization is
// an undefined symbol at LINK time (this executable has no dynamic lookup).
#include <arv.h>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#include <Aravis/Error.h>
#include <convert.h>

static int failures = 0;

#define CHECK(COND, ...)                                                       \
  do {                                                                         \
    if (!(COND)) {                                                             \
      std::printf("FAIL %s:%d: ", __FILE__, __LINE__);                         \
      std::printf(__VA_ARGS__);                                                \
      std::printf("\n");                                                       \
      ++failures;                                                              \
    }                                                                          \
  } while (0)

template <typename E>
static void roundTrip(const char *type,
                      const std::vector<std::pair<E, std::string>> &table) {
  for (const auto &[value, name] : table) {
    CHECK(convert<std::string>(value) == name, "%s %d -> \"%s\"", type,
          (int)value, convert<std::string>(value).c_str());
    CHECK(convert<E>(name) == value, "%s \"%s\" -> %d", type, name.c_str(),
          (int)convert<E>(name));
  }
  bool threw = false;
  try {
    convert<E>(std::string("NotAMode"));
  } catch (const Arv::Error &) {
    threw = true;
  }
  CHECK(threw, "%s unknown string did not throw", type);
  std::printf("ok  %-20s %zu values + unknown\n", type, table.size());
}

int main() {
  roundTrip<ArvAcquisitionMode>(
      "ArvAcquisitionMode", {
                                {ARV_ACQUISITION_MODE_CONTINUOUS, "Continuous"},
                                {ARV_ACQUISITION_MODE_SINGLE_FRAME, "SingleFrame"},
                                {ARV_ACQUISITION_MODE_MULTI_FRAME, "MultiFrame"},
                            });
  roundTrip<ArvAuto>("ArvAuto", {
                                    {ARV_AUTO_OFF, "Off"},
                                    {ARV_AUTO_ONCE, "Once"},
                                    {ARV_AUTO_CONTINUOUS, "Continuous"},
                                });
  roundTrip<ArvExposureMode>(
      "ArvExposureMode",
      {
          {ARV_EXPOSURE_MODE_OFF, "Off"},
          {ARV_EXPOSURE_MODE_TIMED, "Timed"},
          {ARV_EXPOSURE_MODE_TRIGGER_WIDTH, "TriggerWidth"},
          {ARV_EXPOSURE_MODE_TRIGGER_CONTROLLED, "TriggerControlled"},
      });
  if (failures) {
    std::printf("conversions: %d FAILURE(S)\n", failures);
    return 1;
  }
  std::printf("conversions: all passed\n");
  return 0;
}
