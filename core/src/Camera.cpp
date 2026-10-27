// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstring>

#include <napi.h>

#include <Aravis/Camera.h>
#include <Aravis/ClockCalibration.h>
#include <Aravis/Frame.h>
#include <Aravis/Stream.h>
#include <convert.h>

#include "AsyncTask.h"
#include "CoreObject.h"
#include "Iterator.h"
#include "napi-helper.h"

using namespace Napi;

#define GET_PROP(prop, JsType, ...)                                            \
  GET(prop) {                                                                  \
    try {                                                                      \
      return JsType::New(env, __VA_ARGS__(core()->get_##prop()));              \
    }                                                                          \
    JS_EXCEPT(env.Undefined())                                                 \
  }

#define SET_PROP(Prop, Value, ...)                                             \
  SET(Prop) {                                                                  \
    try {                                                                      \
      core()->set_##Prop(__VA_ARGS__(Value));                                  \
    }                                                                          \
    JS_EXCEPT()                                                                \
  }

#define RANGE(name)                                                            \
  GET(name##_range) {                                                          \
    try {                                                                      \
      auto range = core()->get_##name##_range();                               \
      auto obj = Napi::Object::New(env);                                       \
      obj.Set("min", Number::New(env, range.min));                             \
      obj.Set("max", Number::New(env, range.max));                             \
      return obj;                                                              \
    }                                                                          \
    JS_EXCEPT(env.Undefined())                                                 \
  }

#define OPTIONS(name)                                                          \
  GET(name##_options) {                                                        \
    try {                                                                      \
      auto options = core()->get_##name##_options();                           \
      auto ret = Array::New(env, options.size());                              \
      for (size_t i = 0; i < options.size(); ++i)                              \
        ret.Set(i, String::New(env, options[i]));                              \
      return ret;                                                              \
    }                                                                          \
    JS_EXCEPT(env.Undefined())                                                 \
  }

class CameraObject : public CoreObject<CameraObject, Arv::Camera::Ptr> {
  CORE_OBJECT_DECL(CameraObject);

public:
  using CoreObject::CoreObject;
  static inline const std::string name = "Camera";
  static Function Init(Napi::Env env) {
    auto fn = DefineClass(
        env, CameraObject::name.c_str(),
        {
            CORE_OBJECT_REGISTER(CameraObject, env),                   //
            INSTANCE_METHOD(CameraObject, grab),                       //
            INSTANCE_GETTER(CameraObject, stream),                     //
            INSTANCE_GETTER(CameraObject, physical_id),                //
            INSTANCE_GETTER(CameraObject, device_id),                  //
            INSTANCE_GETTER(CameraObject, vendor),                     //
            INSTANCE_GETTER(CameraObject, model),                      //
            INSTANCE_GETTER(CameraObject, serial),                     //
            INSTANCE_ACCESSOR(CameraObject, pixel_format),             //
            INSTANCE_GETTER(CameraObject, pixel_format_options),       //
            INSTANCE_ACCESSOR(CameraObject, acquisition_mode),         //
            INSTANCE_ACCESSOR(CameraObject, frame_count),              //
            INSTANCE_GETTER(CameraObject, frame_count_range),          //
            INSTANCE_ACCESSOR(CameraObject, frame_rate_enable),        //
            INSTANCE_GETTER(CameraObject, frame_rate_available),       //
            INSTANCE_ACCESSOR(CameraObject, frame_rate),               //
            INSTANCE_GETTER(CameraObject, frame_rate_range),           //
            INSTANCE_METHOD(CameraObject, setTrigger),                 //
            INSTANCE_GETTER(CameraObject, trigger_options),            //
            INSTANCE_METHOD(CameraObject, clearTriggers),              //
            INSTANCE_METHOD(CameraObject, softwareTrigger),            //
            INSTANCE_METHOD(CameraObject, stopAcquisition),            //
            INSTANCE_ACCESSOR(CameraObject, trigger_source),           //
            INSTANCE_GETTER(CameraObject, trigger_source_options),     //
            INSTANCE_METHOD(CameraObject, getFeature),                 //
            INSTANCE_METHOD(CameraObject, getFeatureInt),              //
            INSTANCE_METHOD(CameraObject, setFeature),                 //
            INSTANCE_METHOD(CameraObject, setFeatureInt),              //
            INSTANCE_METHOD(CameraObject, getFeatureBool),             //
            INSTANCE_METHOD(CameraObject, setFeatureBool),             //
            INSTANCE_METHOD(CameraObject, executeFeature),             //
            INSTANCE_METHOD(CameraObject, calibrateClock),             //
            INSTANCE_GETTER(CameraObject, clockCalibration),           //
            INSTANCE_GETTER(CameraObject, exposure_time_available),    //
            INSTANCE_GETTER(CameraObject, exposure_auto_available),    //
            INSTANCE_ACCESSOR(CameraObject, exposure),                 //
            INSTANCE_GETTER(CameraObject, exposure_range),             //
            INSTANCE_ACCESSOR(CameraObject, exposure_auto),            //
            INSTANCE_METHOD(CameraObject, getExposureMode),            //
            INSTANCE_METHOD(CameraObject, setExposureMode),            //
            INSTANCE_GETTER(CameraObject, gain_available),             //
            INSTANCE_GETTER(CameraObject, gain_auto_available),        //
            INSTANCE_METHOD(CameraObject, selectGain),                 //
            INSTANCE_GETTER(CameraObject, gain_options),               //
            INSTANCE_ACCESSOR(CameraObject, gain),                     //
            INSTANCE_GETTER(CameraObject, gain_range),                 //
            INSTANCE_ACCESSOR(CameraObject, gain_auto),                //
            INSTANCE_GETTER(CameraObject, black_level_available),      //
            INSTANCE_GETTER(CameraObject, black_level_auto_available), //
            INSTANCE_METHOD(CameraObject, selectBlackLevel),           //
            INSTANCE_GETTER(CameraObject, black_level_options),        //
            INSTANCE_ACCESSOR(CameraObject, black_level),              //
            INSTANCE_GETTER(CameraObject, black_level_range),          //
            INSTANCE_ACCESSOR(CameraObject, black_level_auto),         //
        });
    fn.Set("list", Function::New(env, list, "list"));
    return fn;
  }

  static std::string describe(const CameraObject *obj) {
    return obj->core()->tag;
  }

  // Cascade: releasing the camera also releases its lazily created stream
  // view. The StreamObject holds a Stream::Ptr and the Stream holds the
  // Camera::Ptr — without this, `camera.release()` keeps the DEVICE claimed
  // until GC collects the JS stream object.
  static void destruct(CameraObject *obj) {
    if (obj->stream_ref.IsEmpty())
      return;
    try {
      // This runs from the Cleanup registry at env teardown (RunCleanup),
      // where node provides NO HandleScope — `Reference::Value()` creates a
      // handle, so open a scope explicitly or V8 fatals ("Cannot create a
      // handle without a HandleScope" → abort, SIGABRT on orchestrator exit
      // with any live camera). Harmless extra scope on the JS-call/finalizer
      // paths.
      Napi::HandleScope scope(obj->env);
      auto *stream = StreamObject<Arv::Stream>::Unwrap(obj->stream_ref.Value());
      if (stream)
        stream->releaseNative();
    } catch (...) {
      // Best-effort — the stream object's own cleanup hook backstops teardown.
    }
    obj->stream_ref.Reset();
  }

private:
  using Cameras = std::vector<Arv::Camera::Ptr>;
  static FN(list) {
    return AsyncTask<Cameras>::run(info.Env(), Arv::Camera::list);
  }

  // LAZY stream view (was eagerly attached in `construct`): merely listing
  // cameras must not create an Arv::Stream per device — discovery-pass
  // rejects, matchTriple extras, and the hardware janitor never touch
  // `.stream`, and the eager object leaked past `camera.release()` (see
  // `destruct` above). Cached so repeated reads return the same object.
  Napi::Reference<Napi::Object> stream_ref;
  GET(stream) {
    try {
      if (stream_ref.IsEmpty()) {
        auto stream = Arv::Stream::get(core());
        auto object = StreamObject<Arv::Stream>::Create(env, stream);
        stream_ref = Napi::Persistent(object.As<Napi::Object>());
      }
      return stream_ref.Value();
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(grab) {
    try {
      const auto timeout = info.Length() > 0 && info[0].IsNumber()
                               ? info[0].As<Number>().Int32Value()
                               : 0;
      auto task = [core = core(), timeout] { return core->grab(timeout); };
      return AsyncTask<Arv::Frame::Ptr>::run(env, task);
    }
    JS_EXCEPT(env.Undefined())
  }

  GET_PROP(physical_id, String);
  GET_PROP(device_id, String);
  GET_PROP(vendor, String);
  GET_PROP(model, String);
  GET_PROP(serial, String);

  GET(pixel_format) {
    try {
      auto fmt = convert<Arv::PixelFormat>(core()->get_pixel_format());
      return String::New(env, convert<std::string>(fmt));
    }
    JS_EXCEPT(env.Undefined())
  }
  SET(pixel_format) {
    try {
      auto fmt = convert<Arv::PixelFormat>(val.As<String>().Utf8Value());
      core()->set_pixel_format(convert<ArvPixelFormat>(fmt));
    }
    JS_EXCEPT()
  }
  OPTIONS(pixel_format);

  GET_PROP(acquisition_mode, String,
           (convert<std::string, ArvAcquisitionMode>));
  SET_PROP(acquisition_mode, val.ToString().Utf8Value(),
           (convert<ArvAcquisitionMode, std::string>));

  GET_PROP(frame_count, Number);
  SET_PROP(frame_count, val.As<Number>().Int64Value());
  RANGE(frame_count);

  GET_PROP(frame_rate_enable, Boolean);
  SET_PROP(frame_rate_enable, val.As<Boolean>().Value());
  GET_PROP(frame_rate_available, Boolean);

  GET_PROP(frame_rate, Number);
  SET_PROP(frame_rate, val.As<Number>().DoubleValue());
  RANGE(frame_rate);

  FN(setTrigger) {
    try {
      auto mode = info[0].As<String>().Utf8Value();
      core()->set_trigger(mode.c_str());
      return Boolean::New(env, true);
    }
    JS_EXCEPT(Boolean::New(env, false))
  }
  OPTIONS(trigger);

  FN(clearTriggers) {
    try {
      core()->clear_triggers();
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(softwareTrigger) {
    try {
      core()->software_trigger();
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  // Quiescence failsafe (see Camera.h): AcquisitionStop + TLParamsLocked=0.
  FN(stopAcquisition) {
    try {
      core()->stop_acquisition();
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  SET_PROP(trigger_source, val.As<String>().Utf8Value(),
           (convert<const char *, std::string>));
  GET_PROP(trigger_source, String);
  OPTIONS(trigger_source)

  // Generic GenICam feature access (LineSelector/LineMode/LineSource for
  // strobe output config, etc.) — see Camera.h.
  FN(getFeature) {
    try {
      auto name = info[0].As<String>().Utf8Value();
      return String::New(env, core()->get_feature(name.c_str()));
    }
    JS_EXCEPT(env.Undefined())
  }
  // Integer GenICam node access (Width/Height/etc.) — `getFeature` uses
  // `arv_camera_get_string` and throws on integer nodes ("Not a ArvGcString").
  FN(getFeatureInt) {
    try {
      auto name = info[0].As<String>().Utf8Value();
      return Number::New(env, static_cast<double>(core()->get_feature_int(name.c_str())));
    }
    JS_EXCEPT(env.Undefined())
  }
  FN(setFeature) {
    try {
      auto name = info[0].As<String>().Utf8Value();
      auto value = info[1].As<String>().Utf8Value();
      core()->set_feature(name.c_str(), value.c_str());
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }
  // Integer GenICam node write (`arv_camera_set_integer`). Takes a Number
  // (an integer within the safe range) or a BigInt (lossless int64).
  FN(setFeatureInt) {
    try {
      JS_ASSERT(info.Length() >= 2 && info[0].IsString(), TypeError,
                "setFeatureInt(name, value) expects a string name",
                env.Undefined());
      auto name = info[0].As<String>().Utf8Value();
      int64_t value = 0;
      if (info[1].IsBigInt()) {
        bool lossless = false;
        value = info[1].As<BigInt>().Int64Value(&lossless);
        JS_ASSERT(lossless, RangeError,
                  "setFeatureInt: BigInt value out of int64 range",
                  env.Undefined());
      } else if (info[1].IsNumber()) {
        const double v = info[1].As<Number>().DoubleValue();
        JS_ASSERT(std::isfinite(v) && v == std::floor(v) &&
                      std::fabs(v) <= 9007199254740991.0,
                  RangeError,
                  "setFeatureInt: value must be a safe integer",
                  env.Undefined());
        value = static_cast<int64_t>(v);
      } else {
        JS_THROW(TypeError, "setFeatureInt: value must be a number or bigint",
                 env.Undefined());
      }
      core()->set_feature_int(name.c_str(), value);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }
  // Boolean GenICam node access (`arv_camera_{get,set}_boolean`), e.g.
  // LineInverter — `getFeature`/`setFeature` go through the string API and
  // throw "Not a ArvGcString" on ArvGcBoolean nodes.
  FN(getFeatureBool) {
    try {
      auto name = info[0].As<String>().Utf8Value();
      return Boolean::New(env, core()->get_feature_bool(name.c_str()));
    }
    JS_EXCEPT(env.Undefined())
  }
  FN(setFeatureBool) {
    try {
      JS_ASSERT(info.Length() >= 2 && info[0].IsString() &&
                    info[1].IsBoolean(),
                TypeError,
                "setFeatureBool(name, value) expects a string and a boolean",
                env.Undefined());
      auto name = info[0].As<String>().Utf8Value();
      auto value = info[1].As<Boolean>().Value();
      core()->set_feature_bool(name.c_str(), value);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }
  FN(executeFeature) {
    try {
      auto name = info[0].As<String>().Utf8Value();
      core()->execute_feature(name.c_str());
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  // ---- clock calibration ----------------------------------------------------
  // MANUAL RECALIBRATE trigger: the owner thread (ClockCalibrator, spawned at
  // device init) is the calibration LIFECYCLE — this NAPI is a thin
  // synchronous nudge onto the same guarded routine (per-DEVICE mutex; it
  // serializes against this camera's own drift pass, not bus-wide). ~n GenICam
  // control roundtrips, blocking the calling thread. On success the offset is
  // atomically owner-applied to all subsequent frames, appended to the
  // stability ring, and pushed to `onClockMetrics` when armed; throws when
  // the camera lacks TimestampLatch (the on-demand retry for models whose
  // init pass failed).
  FN(calibrateClock) {
    try {
      int n = 10;
      if (info.Length() > 0 && info[0].IsNumber())
        n = std::max(1, info[0].As<Number>().Int32Value());
      const auto cal = Arv::calibrateCameraClock(*core(), n);
      auto o = Napi::Object::New(env);
      o.Set("offsetNs", BigInt::New(env, cal.offsetNs));
      o.Set("jitterNs", BigInt::New(env, cal.jitterNs));
      o.Set("samples", Number::New(env, static_cast<double>(cal.samples)));
      o.Set("atNs", BigInt::New(env, cal.atNs));
      return o;
    }
    JS_EXCEPT(env.Undefined())
  }

  // The stored calibration + stability row (ageNs at read time; driftPpm
  // between the two most recent runs, null with fewer than 2). Null until an
  // explicit calibrateClock succeeds. All values in the steadyNowNs domain.
  GET(clockCalibration) {
    try {
      const auto s = Arv::clockStability(core()->get_serial());
      if (!s)
        return env.Null();
      return Arv::stabilityToJs(env, *s);
    }
    JS_EXCEPT(env.Undefined())
  }

  GET_PROP(exposure_time_available, Boolean);
  GET_PROP(exposure_auto_available, Boolean);

  GET_PROP(exposure, Number);

  SET_PROP(exposure, val.As<Number>().DoubleValue());
  RANGE(exposure);

  GET_PROP(exposure_auto, String, (convert<std::string, ArvAuto>));
  SET_PROP(exposure_auto, val.As<String>().Utf8Value(),
           (convert<ArvAuto, std::string>));

  FN(getExposureMode) {
    try {
      return String::New(env, convert<std::string>(core()->get_exposure_mode()));
    }
    JS_EXCEPT(env.Null())
  }

  FN(setExposureMode) {
    try {
      auto mode = info[0].As<String>().Utf8Value();
      core()->set_exposure_mode(convert<ArvExposureMode>(mode));
      return Boolean::New(env, true);
    }
    JS_EXCEPT(Boolean::New(env, false))
  }

  /* Analog control */

  GET_PROP(gain_available, Boolean);
  GET_PROP(gain_auto_available, Boolean);
  FN(selectGain) {
    try {
      auto selector = info[0].As<String>().Utf8Value();
      core()->select_gain(selector.c_str());
      return Boolean::New(env, true);
    }
    JS_EXCEPT(Boolean::New(env, false))
  }
  OPTIONS(gain)

  GET_PROP(gain, Number);
  SET_PROP(gain, val.As<Number>().DoubleValue());
  RANGE(gain);
  GET_PROP(gain_auto, String, (convert<std::string, ArvAuto>));
  SET_PROP(gain_auto, val.As<String>().Utf8Value(),
           (convert<ArvAuto, std::string>));

  GET_PROP(black_level_available, Boolean);
  GET_PROP(black_level_auto_available, Boolean);
  FN(selectBlackLevel) {
    try {
      auto selector = info[0].As<String>().Utf8Value();
      core()->select_black_level(selector.c_str());
      return Boolean::New(env, true);
    }
    JS_EXCEPT(Boolean::New(env, false))
  }
  OPTIONS(black_level)

  GET_PROP(black_level, Number);
  SET_PROP(black_level, val.As<Number>().DoubleValue());
  RANGE(black_level);

  GET_PROP(black_level_auto, String, (convert<std::string, ArvAuto>));
  SET_PROP(black_level_auto, val.As<String>().Utf8Value(),
           (convert<ArvAuto, std::string>));
};

CORE_OBJECT(CameraObject);

CONVERT_ARRAY_OF(Arv::Camera::Ptr);

CORE_OBJECT_CONVERSIONS(StreamObject<Arv::Stream>);
