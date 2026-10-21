#pragma once

#include "Sensor.h"

#include <cstdint>

/*
 * MAX4466 electret microphone module on an ESP32 ADC pin.
 *
 * The module outputs an audio signal biased at half its supply voltage, so the
 * useful content is the AC part riding on that DC offset. This sensor samples a
 * short window and reports the RMS of the AC part as a RELATIVE level in dBFS:
 *
 *     0 dBFS  = signal swinging the whole ADC range
 *    -90 dBFS  = reported floor (silence or no signal)
 *
 * It is not a calibrated sound pressure level. A MAX4466 board has no absolute
 * acoustic reference and its gain is set by a trim pot, so comparisons are only
 * valid between windows from the same node with the same pot position.
 *
 * Wiring: VCC to 3V3 (never 5 V, the output bias would exceed the ADC range),
 * GND to GND, OUT to an ADC1 pin (GPIO32-39 on the ESP32 dev board).
 */
class SoundSensor : public Sensor
{
public:
  SoundSensor(const char *id, std::uint8_t analogPin,
              std::uint16_t windowMs = 50, bool enabled = true);

  std::size_t getReadingCount() const { return mReadingCount; }
  bool read(SensorReading *readings, std::size_t capacity) override;

private:
  bool begin() override;
  bool end() override { return true; }

  std::uint8_t mAnalogPin;
  std::uint16_t mWindowMs;
  std::size_t mReadingCount = 1;
};
