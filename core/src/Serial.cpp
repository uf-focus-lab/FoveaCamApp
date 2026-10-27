// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstddef>
#include <cstring>

#include <napi.h>
#include <sys/fcntl.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

#include <Aravis/Camera.h>
#include <Aravis/Frame.h>
#include <Aravis/Stream.h>
#include <COBS/RX.h>
#include <COBS/TX.h>
#include <Protocol/Packet.h>
#include <Threading/Guard.h>
#include <convert.h>
#include <pointer.h>

#include "napi-helper.h"

// Used by Protocol object constructor.

int SerialOpen(const Napi::CallbackInfo &info) noexcept {
  const auto env = info.Env();
  const auto path = convert<std::string>(info[0]);
  const speed_t baud = optionalArgument<uint32_t>(info[1], 115200);
  VERBOSE("Opening serial port %s (baudrate=%lu)", path.c_str(), baud);
  // Open serial port
  int fd = ::open(path.c_str(), O_RDWR | O_NOCTTY | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0)
    JS_THROW(Error, "Failed to open serial port: " + path, -1);

  // Set exclusive access (macOS/BSD) to prevent interference from other
  // processes
#ifdef TIOCEXCL
  if (ioctl(fd, TIOCEXCL) == -1) {
    WARN("Failed to set exclusive access on serial port: %s",
         std::strerror(errno));
    // Not fatal - continue anyway
  }
#endif

  // Configure serial port
  struct termios tty;
  if (tcgetattr(fd, &tty) != 0) {
    ::close(fd);
    JS_THROW(Error, "Failed to get serial port attributes", -1);
  }
  // Set baud rate. The controller is a Teensy 4.0 USB CDC-ACM device
  // (480 Mbit/s high-speed USB): the line rate is a NO-OP on it — bytes move
  // at USB speed whatever is set here, so nothing host-side may assume a
  // real UART's per-byte time (115200 baud would be ~87 µs/byte; the real
  // per-packet cost is USB microframe + MCU loop latency, see
  // docs/spec/serial-protocol.md#pipelining). It stays settable for a real
  // UART bridge. (Never 134: Teensy treats that line coding as "reboot into
  // the bootloader".) termios wants the B<rate> constant, not the integer —
  // on Linux B115200 != 115200 and cfset*speed(115200) fails with EINVAL.
  speed_t speed;
  switch (baud) {
  case 9600:
    speed = B9600;
    break;
  case 19200:
    speed = B19200;
    break;
  case 38400:
    speed = B38400;
    break;
  case 57600:
    speed = B57600;
    break;
  case 115200:
    speed = B115200;
    break;
  case 230400:
    speed = B230400;
    break;
  default:
    ::close(fd);
    JS_THROW(Error, "Unsupported baud rate: " + std::to_string(baud), -1);
  }
  cfsetispeed(&tty, speed);
  cfsetospeed(&tty, speed);
  // Configure 8N1 (8 data bits, no parity, 1 stop bit) by default
  tty.c_cflag &= ~PARENB; // No parity
  tty.c_cflag &= ~CSTOPB; // 1 stop bit
  tty.c_cflag &= ~CSIZE;
  tty.c_cflag |= CS8; // 8 data bits
  // Disable hardware flow control
  tty.c_cflag &= ~CRTSCTS;
  // Enable reading and ignore modem control lines
  tty.c_cflag |= CREAD | CLOCAL;
  // Disable canonical mode, echo, and signal chars
  tty.c_lflag &= ~(ICANON | ECHO | ECHOE | ECHONL | ISIG);
  // Disable software flow control and special handling
  tty.c_iflag &= ~(IXON | IXOFF | IXANY);
  tty.c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL);
  // Disable output processing
  tty.c_oflag &= ~OPOST;
  tty.c_oflag &= ~ONLCR;
  // Set read timeout to non-blocking
  tty.c_cc[VTIME] = 0;
  tty.c_cc[VMIN] = 0;
  // Apply settings
  if (tcsetattr(fd, TCSANOW, &tty) != 0) {
    ::close(fd);
    JS_THROW(Error, "Failed to set serial port attributes", -1);
  }
  // Flush any existing data
  tcflush(fd, TCIOFLUSH);
  // fd now ready for use
  return fd;
}
