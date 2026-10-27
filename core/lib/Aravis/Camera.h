#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <arv.h>
#include <convert.h>

#include <utils/ref-count.h>

#include "Error.h"
#include "Frame.h"
#include "Object.h"

namespace Arv {

template <typename T> struct Range {
  T min;
  T max;
};

class ClockCalibrator; // owner-thread clock calibration (ClockCalibration.h)

class Camera : public Object<ArvCamera, Camera> {
public:
  typedef RefCount::Reference<Camera> Ptr;
  static std::vector<Ptr> list();

public:
  const std::string id;
  // Construct from device ID. Spawns the camera's OWNER-THREAD clock
  // calibrator (initial latch pass + periodic drift re-runs — see
  // ClockCalibration.h); a latch-unsupported model stays uncalibrated (dt 0).
  Camera(std::string id);
  // Out-of-line: joins the calibrator thread (ClockCalibrator is incomplete
  // here — defined in ClockCalibration.h, included by Camera.cpp).
  ~Camera();
  // Disallow copy/move
  Camera(const Camera &other) = delete;
  Camera(Camera &&other) = delete;

public:
  const std::string tag;
  Frame::Ptr grab(uint64_t timeout = 0) const;

  inline const std::string &get_physical_id() const { return id; }

#define ARV_CAMERA_FN(type, name, prop)                                        \
  inline type name() const {                                                   \
    auto ret = arv_camera_##prop(get(), &Error::error);                        \
    Error::check("arv_camera_" #prop);                                         \
    return ret;                                                                \
  }

#define ARV_CAMERA_FN_VOID(name, prop)                                         \
  inline void name() const {                                                   \
    arv_camera_##prop(get(), &Error::error);                                   \
    Error::check("arv_camera_" #prop);                                         \
  }

#define ARV_CAMERA_IS(type, name, prop)                                        \
  inline type get_##name() const {                                             \
    auto ret = arv_camera_is_##prop(get(), &Error::error);                     \
    Error::check("arv_camera_is_" #prop);                                      \
    return ret;                                                                \
  }

#define ARV_CAMERA_GET(type, name, prop)                                       \
  inline type get_##name() const {                                             \
    auto ret = arv_camera_get_##prop(get(), &Error::error);                    \
    Error::check("arv_camera_get_" #prop);                                     \
    return ret;                                                                \
  }

#define ARV_CAMERA_SET(type, name, prop)                                       \
  inline void set_##name(type value) const {                                   \
    arv_camera_set_##prop(get(), value, &Error::error);                        \
    Error::check("arv_camera_set_" #prop);                                     \
  }

#define ARV_CAMERA_BOUNDS(type, name, prop)                                    \
  inline Range<type> get_##name##_range() const {                              \
    Range<type> range;                                                         \
    arv_camera_get_##prop##_bounds(get(), &range.min, &range.max,              \
                                   &Error::error);                             \
    Error::check("arv_camera_get_" #prop "_bounds");                           \
    return range;                                                              \
  }

#define ARV_CAMERA_DUP(name, prop)                                             \
  inline std::vector<std::string> get_##name() const {                         \
    unsigned int count;                                                        \
    const char **list =                                                        \
        arv_camera_dup_available_##prop(get(), &count, &Error::error);         \
    Error::check("arv_camera_dup_available_" #prop);                           \
    std::vector<std::string> ret;                                              \
    if (list) {                                                                \
      ret.reserve(count);                                                      \
      for (size_t i = 0; i < count; ++i) {                                     \
        ret.emplace_back(list[i]);                                             \
      }                                                                        \
      g_free(list);                                                            \
    }                                                                          \
    return ret;                                                                \
  }

  /* Device information */
  ARV_CAMERA_GET(const char *, device_id, device_id);
  ARV_CAMERA_GET(const char *, vendor, vendor_name);
  ARV_CAMERA_GET(const char *, model, model_name);
  ARV_CAMERA_GET(const char *, serial, device_serial_number);
  ARV_CAMERA_GET(ArvPixelFormat, pixel_format, pixel_format);
  ARV_CAMERA_SET(ArvPixelFormat, pixel_format, pixel_format);
  inline std::vector<std::string> get_pixel_format_options() const {
    unsigned int count;
    const char **list =
        arv_camera_dup_available_pixel_formats_as_strings(get(), &count,
                                                          &Error::error);
    Error::check("arv_camera_dup_available_pixel_formats_as_strings");
    std::vector<std::string> ret;
    if (list) {
      ret.reserve(count);
      for (size_t i = 0; i < count; ++i) {
        try {
          const auto format = convert<PixelFormat>(std::string(list[i]));
          if (canViewAs(format, RGBA8))
            ret.emplace_back(convert<std::string>(format));
        } catch (const UnknownPixelFormat &) {
          // Keep selection limited to formats the Frame preview path supports.
        }
      }
      g_free(list);
    }
    return ret;
  }

  /* Acquisition control */

  ARV_CAMERA_GET(ArvAcquisitionMode, acquisition_mode, acquisition_mode);
  ARV_CAMERA_SET(ArvAcquisitionMode, acquisition_mode, acquisition_mode);

  ARV_CAMERA_GET(int64_t, frame_count, frame_count);
  ARV_CAMERA_SET(int64_t, frame_count, frame_count);
  ARV_CAMERA_BOUNDS(int64_t, frame_count, frame_count);

#if ARAVIS_CHECK_VERSION(0, 8, 31)
  ARV_CAMERA_GET(bool, frame_rate_enable, frame_rate_enable);
#else
  // arv_camera_get_frame_rate_enable() was added after 0.8.30 (Ubuntu 24.04
  // ships 0.8.30, which has only the setter). Read the underlying GenICam
  // feature directly — the same feature the setter and the native getter drive.
  inline bool get_frame_rate_enable() const {
    auto ret =
        arv_camera_get_boolean(get(), "AcquisitionFrameRateEnable", &Error::error);
    Error::check("arv_camera_get_boolean(AcquisitionFrameRateEnable)");
    return ret;
  }
#endif
  ARV_CAMERA_SET(bool, frame_rate_enable, frame_rate_enable);
  inline bool get_frame_rate_available() const {
    auto ret = arv_camera_is_frame_rate_available(get(), &Error::error);
    Error::check("arv_camera_is_frame_rate_available");
    return ret;
  }

  ARV_CAMERA_GET(double, frame_rate, frame_rate);
  ARV_CAMERA_SET(double, frame_rate, frame_rate);
  ARV_CAMERA_BOUNDS(double, frame_rate, frame_rate);

  ARV_CAMERA_SET(const char *, trigger, trigger);
  ARV_CAMERA_DUP(trigger_options, triggers);

  ARV_CAMERA_FN_VOID(clear_triggers, clear_triggers);
  ARV_CAMERA_FN_VOID(software_trigger, software_trigger);

  /* Hardware-quiescence failsafe: AcquisitionStop + TLParamsLocked=0 in
   * Aravis's canonical order. Safe on an idle camera. The main-process
   * janitor uses this to stop a camera left streaming by a crashed
   * orchestrator (a locked camera rejects every config write with
   * USB3Vision access-denied until unlocked). */
  ARV_CAMERA_FN_VOID(stop_acquisition, stop_acquisition);

  ARV_CAMERA_SET(const char *, trigger_source, trigger_source);
  ARV_CAMERA_GET(const char *, trigger_source, trigger_source);
  ARV_CAMERA_DUP(trigger_source_options, trigger_sources);

  /* Generic GenICam feature access — for features without a dedicated
   * accessor above, e.g. configuring a strobe/line output as ExposureActive
   * (LineSelector + LineMode + LineSource) for synced capture. */
  inline std::string get_feature(const char *name) const {
    auto ret = arv_camera_get_string(get(), name, &Error::error);
    Error::check("arv_camera_get_string");
    return ret ? std::string(ret) : std::string();
  }
  /* Integer GenICam node access (e.g. Width/Height, which are ArvGcIntegerNode
   * and would fail `arv_camera_get_string`). */
  inline int64_t get_feature_int(const char *name) const {
    auto ret = arv_camera_get_integer(get(), name, &Error::error);
    Error::check("arv_camera_get_integer");
    return ret;
  }
  inline void set_feature(const char *name, const char *value) const {
    arv_camera_set_string(get(), name, value, &Error::error);
    Error::check("arv_camera_set_string");
  }
  inline void set_feature_int(const char *name, int64_t value) const {
    arv_camera_set_integer(get(), name, static_cast<gint64>(value),
                           &Error::error);
    Error::check("arv_camera_set_integer");
  }
  /* Boolean GenICam node access (e.g. LineInverter, an ArvGcBoolean that
   * `arv_camera_set_string` refuses with "Not a ArvGcString"). */
  inline bool get_feature_bool(const char *name) const {
    auto ret = arv_camera_get_boolean(get(), name, &Error::error);
    Error::check("arv_camera_get_boolean");
    return ret;
  }
  inline void set_feature_bool(const char *name, bool value) const {
    arv_camera_set_boolean(get(), name, value ? TRUE : FALSE, &Error::error);
    Error::check("arv_camera_set_boolean");
  }
  inline void execute_feature(const char *name) const {
    arv_camera_execute_command(get(), name, &Error::error);
    Error::check("arv_camera_execute_command");
  }

  ARV_CAMERA_IS(bool, exposure_time_available, exposure_time_available);
  ARV_CAMERA_IS(bool, exposure_auto_available, exposure_auto_available);

  ARV_CAMERA_GET(double, exposure, exposure_time);
  ARV_CAMERA_SET(double, exposure, exposure_time);
  ARV_CAMERA_BOUNDS(double, exposure, exposure_time);

  ARV_CAMERA_GET(ArvAuto, exposure_auto, exposure_time_auto);
  ARV_CAMERA_SET(ArvAuto, exposure_auto, exposure_time_auto);

  ARV_CAMERA_SET(ArvExposureMode, exposure_mode, exposure_mode);
  // Aravis has no arv_camera_get_exposure_mode; read the SFNC node directly.
  inline ArvExposureMode get_exposure_mode() const {
    return convert<ArvExposureMode>(get_feature("ExposureMode"));
  }

  /* Analog control */

  ARV_CAMERA_IS(bool, gain_available, gain_available);
  ARV_CAMERA_IS(bool, gain_auto_available, gain_auto_available);
  void select_gain(const char *selector) const {
    arv_camera_select_gain(get(), selector, &Error::error);
    Error::check("arv_camera_select_gain");
  }
  ARV_CAMERA_DUP(gain_options, gains);

  ARV_CAMERA_GET(double, gain, gain);
  ARV_CAMERA_SET(double, gain, gain);
  ARV_CAMERA_BOUNDS(double, gain, gain);
  ARV_CAMERA_GET(ArvAuto, gain_auto, gain_auto);
  ARV_CAMERA_SET(ArvAuto, gain_auto, gain_auto);

  ARV_CAMERA_IS(bool, black_level_available, black_level_available);
  ARV_CAMERA_IS(bool, black_level_auto_available, black_level_auto_available);
  void select_black_level(const char *selector) const {
    arv_camera_select_black_level(get(), selector, &Error::error);
    Error::check("arv_camera_select_black_level");
  }
  ARV_CAMERA_DUP(black_level_options, black_levels);

  ARV_CAMERA_GET(double, black_level, black_level);
  ARV_CAMERA_SET(double, black_level, black_level);
  ARV_CAMERA_BOUNDS(double, black_level, black_level);
  ARV_CAMERA_GET(ArvAuto, black_level_auto, black_level_auto);
  ARV_CAMERA_SET(ArvAuto, black_level_auto, black_level_auto);

  /* OWNER-APPLIED clock offset. The
   * device→host dt (ns, steadyNowNs domain — see ClockCalibration.h) lives on
   * the camera and is applied at Frame creation, the single choke point where
   * device timestamps enter the system — so JS Frame.deviceTimestamp, every
   * SHM SlotHeader, the OwnedFrame taps and KCF results all surface
   * pre-calibrated time automatically. Defaults to 0 (uncalibrated) until an
   * explicit `calibrateClock` succeeds. ATOMIC swap by design: mid-task
   * recalibration never quiesces the stream — in-flight frames keep the
   * offset they were stamped with; a small step at the swap is accepted,
   * never torn. Const + mutable: calibration runs against Ptr-const access.
   * The RAW counter stays available to the calibrator itself via the
   * TimestampLatch features (never offset by us — we never touch the device
   * clock). */
  inline int64_t get_clock_offset_ns() const {
    return clock_offset_ns_.load(std::memory_order_acquire);
  }
  inline void set_clock_offset_ns(int64_t offsetNs) const {
    clock_offset_ns_.store(offsetNs, std::memory_order_release);
  }
  /* Per-DEVICE calibration guard (two-tier locking, ClockCalibration.h):
   * serializes this camera's owner-thread drift passes against a manual
   * `calibrateClock` nudge. The GLOBAL mutex (initial passes only) lives in
   * ClockCalibration.cpp. */
  inline std::mutex &clock_cal_mutex() const { return clock_cal_mutex_; }

private:
  mutable std::atomic<int64_t> clock_offset_ns_{0};
  mutable std::mutex clock_cal_mutex_;
  // Declared LAST: constructed after the device is fully open, destroyed
  // FIRST (stop+join before anything the thread touches goes away).
  std::unique_ptr<ClockCalibrator> calibrator_;
};

} // namespace Arv
