// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>

#include <Protocol/Packet.h>
#include <Protocol/Protocol.h>

#include "Board.h"
#include "Capture.h"
#include "Global.h"
#include "Streams.h"

void setup() {
  Serial.begin(115200);
  // No SPI.begin(): the MEMS DAC buses are bit-banged GPIO (MEMS.cpp), and
  // LPSPI4 would claim pins 11/12 (MOSI2/SCLK2) and 13 (a camera line).
  Board::init();
  Board::fclk.freq(Global::lpf_frequency);
  Capture::init();
}

void handle(const Protocol::RawPacket &&packet);
namespace Protocol {
void tick(); // Non-blocking Actuate/Trigger completion (Protocol.cpp)
}

void loop() {
  Global::time.update();
  Streams::housekeeping(); // M1 periodic MEMS config re-assertion (~1 Hz)
  Streams::tick();
  Capture::tick();
  Protocol::tick();
  for (int available = Serial.available(); available > 0; available--) {
    auto byte = Serial.read();
    if (byte >= 0 && COBS::rx.recv(byte))
      handle(COBS::rx.get());
  }
}

#define HEADER(M, P)                                                           \
  (Protocol::header(Protocol::Method::M, Protocol::Property::P))

#define CASE_GET(P)                                                            \
  case Protocol::header(Protocol::Method::GET, Packet::P::PROPERTY):           \
    Packet::P::GET(seq);                                                       \
    break;

// Payload-carrying GET (CMD_FRAME) — validate + inflate like CASE_SET, but
// dispatch to the two-argument Prototype::GET overload.
#define CASE_GET_PAYLOAD(P)                                                    \
  case Protocol::header(Protocol::Method::GET, Packet::P::PROPERTY): {         \
    if (Packet::P::validate(packet))                                          \
      Packet::P::GET(seq, Packet::P::inflate(packet));                        \
    else                                                                      \
      Packet::P::reject(seq, "Invalid packet");                               \
    break;                                                                    \
  }

#define CASE_SET(P)                                                            \
  case Protocol::header(Protocol::Method::SET, Packet::P::PROPERTY): {         \
    if (Packet::P::validate(packet))                                           \
      Packet::P::SET(seq, Packet::P::inflate(packet));                         \
    else                                                                       \
      Packet::P::reject(seq, "Invalid packet");                                \
    break;                                                                     \
  }

void handle(const Protocol::RawPacket &&packet) {
  const auto header = packet.validate();
  const auto &seq = packet.header().sequence;
  switch (header) {
    CASE_GET(System::Info);
    CASE_GET(System::Version);
    CASE_SET(System::Reset);
    CASE_GET(System::Enable);
    CASE_SET(System::Enable);
    CASE_GET(System::Timestamp);
    CASE_SET(System::Timestamp);
    CASE_GET(Config::Log);
    CASE_SET(Config::Log);
    CASE_GET(Config::LPF);
    CASE_SET(Config::LPF);
    CASE_GET(Config::Bias);
    CASE_SET(Config::Bias);
    CASE_SET(Command::MirrorStream);
    CASE_GET_PAYLOAD(Command::Frame);
    CASE_SET(Command::Actuate);
    CASE_SET(Command::Trigger);
  case Protocol::INVALID: {
    auto packet = Packet::reject("Bad packet");
    if (COBS::tx.encode(packet))
      Serial.write(COBS::tx.data(), COBS::tx.size());
    break;
  }
  default: {
    auto packet = Packet::reject("Unknown packet type");
    if (COBS::tx.encode(packet))
      Serial.write(COBS::tx.data(), COBS::tx.size());
    break;
  }
  }
};
