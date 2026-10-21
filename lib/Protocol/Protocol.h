// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <cstdint>
#include <sys/types.h>
#include <vector>

#include <Buffer/Buffer.h>
#include <type_name.h> // type_name<Payload>() in FixedSizePacket::inflate

namespace Protocol {

// Methods occupy the header's upper nibble. GET/SET are requests; ACK/REJ/FIN
// are responses. FIN completes the originating request sequence only for
// two-phase properties (CMD_ACTUATE, CMD_TRIGGER, CMD_FRAME); single-phase
// properties resolve on ACK alone. SYN is push data, not a request response.
#define FOVEA_PROTOCOL_METHODS(X)                                             \
  X(NOP, 0x00)                                                                \
  X(GET, 0x10)                                                                \
  X(SET, 0x20)                                                                \
  X(ACK, 0x30)                                                                \
  X(REJ, 0x40)                                                                \
  X(FIN, 0x50)                                                                \
  X(SYN, 0xF0)

typedef enum Method : uint8_t {
#define FOVEA_PROTOCOL_METHOD_ENUM(Name, Value) Name = Value,
  FOVEA_PROTOCOL_METHODS(FOVEA_PROTOCOL_METHOD_ENUM)
#undef FOVEA_PROTOCOL_METHOD_ENUM
} Method;

// Properties occupy the header's lower nibble. SYS_* are System properties;
// CFG_* are Configuration properties; CMD_STREAM/CMD_FRAME cover stream
// lifecycle, continuous position updates, and triggered frames; CMD_ACTUATE
// and CMD_TRIGGER are Commands. LOG is pushed from the MCU to the host.
// SYS_TIMESTAMP (clock calibration, v1.1) sits out of group order because the
// existing nibble values are frozen on the wire.
#define FOVEA_PROTOCOL_PROPERTIES(X)                                          \
  X(NONE, 0x00)                                                               \
  X(SYS_INFO, 0x01)                                                           \
  X(SYS_VERSION, 0x02)                                                        \
  X(SYS_RESET, 0x03)                                                          \
  X(SYS_ENABLE, 0x04)                                                         \
  X(CFG_LOG, 0x05)                                                            \
  X(CFG_LPF, 0x06)                                                            \
  X(CFG_BIAS, 0x07)                                                           \
  X(CMD_STREAM, 0x08)                                                         \
  X(CMD_FRAME, 0x09)                                                          \
  X(CMD_ACTUATE, 0x0A)                                                        \
  X(CMD_TRIGGER, 0x0B)                                                        \
  X(SYS_TIMESTAMP, 0x0C)                                                      \
  X(LOG, 0x0F)

typedef enum Property : uint8_t {
#define FOVEA_PROTOCOL_PROPERTY_ENUM(Name, Value) Name = Value,
  FOVEA_PROTOCOL_PROPERTIES(FOVEA_PROTOCOL_PROPERTY_ENUM)
#undef FOVEA_PROTOCOL_PROPERTY_ENUM
} Property;

using Vector = std::vector<uint8_t>;

inline constexpr uint8_t header(Method method, Property property) {
  return static_cast<uint8_t>(method) | static_cast<uint8_t>(property);
}

inline constexpr Method method(uint8_t header) {
  return static_cast<Method>(header & 0xF0); // Upper 4 bits
}

inline constexpr Property property(uint8_t header) {
  return static_cast<Property>(header & 0x0F); // Lower 4 bits
}

constexpr uint8_t INVALID = Protocol::header(NOP, NONE); // 0

template <typename Int> inline constexpr uint8_t u8(Int v, unsigned shift) {
  return (v >> shift) & 0xFF;
}

#define PACKED(NAME)                                                           \
  typedef struct NAME NAME;                                                    \
  struct __attribute__((__packed__)) NAME

// Sequence == 0 marks a fire-and-forget request: the firmware performs the
// action but sends no ACK/FIN/REJ (used for high-rate stream UPDATEs). SYN
// pushes (e.g. LOG) are unrelated and always sent regardless of sequence.
typedef uint16_t Sequence;

PACKED(Header) {
  uint8_t checksum;
  uint8_t header;
  Sequence sequence;
};
static_assert(sizeof(Header) == 4, "Protocol::Header size incorrect");

void reject(const Sequence &seq, Property p, const std::string &reason);

/**
 * @brief Layout (size = n):
 *   [ 0 ] - Checksum
 *   [ 1 ] - Header
 *   [2-3] - Sequence Number (uint16_t) Little Endian
 *   [4-n] - Variable Payload
 */
class RawPacket : public Vector {
public:
  inline RawPacket(Vector &&rx) : Vector(rx) {}
  inline RawPacket(Method method, Property property, uint16_t sequence)
      : Vector({0, Protocol::header(method, property), u8(sequence, 0),
                u8(sequence, 8)}) {}
  /**
   * @brief Get the header of the packet.
   *
   * @return const Header&
   */
  inline const Header &header() const {
    return *reinterpret_cast<const Header *>(&at(0));
  }
  inline Header &header() { return *reinterpret_cast<Header *>(&at(0)); }
  /**
   * @brief Validate the packet's checksum.
   *
   * @return uint8_t The header if valid, 0 otherwise.
   */
  inline uint8_t validate() const {
    if (size() < sizeof(Header))
      return INVALID; // NOP:NONE
    uint8_t sum = 0;
    for (const auto &byte : *this)
      sum ^= byte;
    return sum == 0 ? header().header : INVALID;
  }
  /**
   * @brief Finalize the packet by computing the checksum.
   */
  inline Vector &finalize() {
    if (size() < sizeof(Header))
      CRASH(runtime_error, "Protocol::RawPacket::finalize: Packet too short");
    for (auto &byte : *this)
      header().checksum ^= byte;
    return *this;
  }
  /**
   * @brief Copy data to packet payload.
   *
   * @param data
   * @param len
   */
  void setData(const void *data, size_t len) {
    if (len + sizeof(Header) > size())
      resize(len + sizeof(Header));
    std::memcpy(&at(sizeof(Header)), data, len);
  }
  /**
   * @brief Copy data to packet payload.
   *
   * @param data
   * @param len
   */
  template <typename T> void setData(Buffer<T> buffer) {
    setData(buffer.data, buffer.size * sizeof(T));
  }
  /**
   * @brief Get pointer to payload data.
   * @return uint8_t*
   */
  uint8_t *data() {
    if (size() < sizeof(Header))
      return nullptr;
    return &at(sizeof(Header));
  }
  /**
   * @brief Get pointer to payload data.
   * @return uint8_t*
   */
  const uint8_t *data() const {
    if (size() < sizeof(Header))
      return nullptr;
    return &at(sizeof(Header));
  }
  /**
   * @brief Get pointer to payload data.
   *
   * @return size_t
   */
  size_t dataSize() const {
    if (size() < sizeof(Header))
      return 0;
    return size() - sizeof(Header);
  }
};

// Finalizes and transmits a response/push packet, honoring the seq==0
// fire-and-forget convention (no bytes go out for ACK/FIN/REJ with seq==0).
// Implemented per-platform (firmware/src/Protocol.cpp on the MCU side);
// unused (and unimplemented) on the host.
void send(RawPacket &packet);

template <Property P> class Packet {
public:
  static inline constexpr Property PROPERTY = P;
  class Create {
  public:
    static inline RawPacket GET(uint16_t seq) {
      return {Method::GET, PROPERTY, seq};
    }
    static inline RawPacket SET(uint16_t seq) {
      return {Method::SET, PROPERTY, seq};
    }
    static inline RawPacket ACK(uint16_t seq) {
      return {Method::ACK, PROPERTY, seq};
    }
    static inline RawPacket REJ(uint16_t seq) {
      return {Method::REJ, PROPERTY, seq};
    }
    static inline RawPacket FIN(uint16_t seq) {
      return {Method::FIN, PROPERTY, seq};
    }
    static inline RawPacket SYN(uint16_t seq) {
      return {Method::SYN, PROPERTY, seq};
    }
  };
  static inline void reject(const Sequence &seq, std::string reason) {
    Protocol::reject(seq, P, reason);
  }
};

template <typename T, Property P> class FixedSizePacket : public Packet<P> {
public:
  using Payload = T;
  using Prototype = FixedSizePacket<Payload, P>;
  using Inflated = const Payload &;
  static bool validate(const RawPacket &packet) {
    return packet.dataSize() == sizeof(Payload);
  }
  static Inflated inflate(const RawPacket &packet) {
    if (packet.dataSize() != sizeof(Payload))
      CRASH(runtime_error,
            "Protocol::inflate: Packet too short for " + type_name<Payload>());
    return *reinterpret_cast<Payload *>(const_cast<uint8_t *>(packet.data()));
  }
  static void deflate(const Payload &data, RawPacket &packet) {
    packet.setData(&data, sizeof(Payload));
  }
  // Declaration of packet handler, may not be implemented if unused
  // Only used on MCU side
  static void GET(const Sequence &seq);
  // Payload-carrying GET overload (e.g. CMD_FRAME, a request with an
  // argument rather than a plain read).
  static void GET(const Sequence &seq, Inflated);
  static void SET(const Sequence &seq, Inflated);
  static void ACK(const Sequence &seq, Inflated);
  static void SYN(const Sequence &seq, Inflated);
};

#define FIXED_SIZE_PACKET(NAME, PROP)                                          \
  PACKED(NAME)                                                                 \
      : public Protocol::FixedSizePacket<NAME, Protocol::Property::PROP>

template <Protocol::Property P>
class BufferPacket : public Protocol::Packet<P> {
public:
  using Prototype = BufferPacket<P>;
  using Inflated = const Buffer<uint8_t>;
  static constexpr bool validate(const Protocol::RawPacket &packet) {
    return true;
  }
  static const Inflated inflate(Protocol::RawPacket &packet) {
    return {packet.data(), packet.dataSize()};
  }
  static void deflate(const Buffer<uint8_t> &data,
                      Protocol::RawPacket &packet) {
    packet.setData(data.data, data.size);
  }
  // Declaration of packet handler, may not be implemented if unused
  // Only used on MCU side
  static void GET(const Sequence &seq);
  static void SET(const Sequence &seq, Inflated);
  static void ACK(const Sequence &seq, Inflated);
  static void SYN(const Sequence &seq, Inflated);
};

template <Protocol::Property P>
class StringPacket : public Protocol::Packet<P> {
public:
  using Prototype = StringPacket<P>;
  using Inflated = const std::string;
  static constexpr bool validate(const Protocol::RawPacket &packet) {
    return true;
  }
  static const Inflated inflate(Protocol::RawPacket &packet) {
    return {reinterpret_cast<const char *>(packet.data()), packet.dataSize()};
  }
  static void deflate(const std::string &data, Protocol::RawPacket &packet) {
    packet.setData(reinterpret_cast<const uint8_t *>(data.data()), data.size());
  }
  // Declaration of packet handler, may not be implemented if unused
  // Only used on MCU side
  static void GET(const Sequence &seq);
  static void SET(const Sequence &seq, Inflated);
  static void ACK(const Sequence &seq, Inflated);
  static void SYN(const Sequence &seq, Inflated);
};

} // namespace Protocol
