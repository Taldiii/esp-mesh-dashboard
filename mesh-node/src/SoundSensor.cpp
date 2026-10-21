#include "SoundSensor.h"

#include <Arduino.h>
#include <cmath>

namespace
{
  // 12-bit ADC: 0..4095, with the MAX4466 idle level near the midpoint.
  constexpr double kAdcMaxCounts = 4095.0;
  constexpr double kAdcReferenceCounts = kAdcMaxCounts / 2.0;
  constexpr float kSilenceFloorDb = -90.0f;
} // namespace

SoundSensor::SoundSensor(const char *id, std::uint8_t analogPin,
                         std::uint16_t windowMs, bool enabled)
    : Sensor(id, enabled), mAnalogPin(analogPin), mWindowMs(windowMs) {}

bool SoundSensor::begin()
{
  pinMode(mAnalogPin, INPUT);
  setInitialized(true);
  return true;
}

bool SoundSensor::read(SensorReading *readings, std::size_t capacity)
{
  if (!hasValidReadingBuffer(readings, capacity))
  {
    return false;
  }

  // One pass over the window: the running sum and sum of squares yield both the
  // DC bias and the total mean square, so the AC RMS needs no sample buffer.
  const unsigned long startMs = millis();
  double sum = 0.0;
  double sumSquares = 0.0;
  std::size_t count = 0;

  do
  {
    const double sample = static_cast<double>(analogRead(mAnalogPin));
    sum += sample;
    sumSquares += sample * sample;
    ++count;
  } while (millis() - startMs < mWindowMs);

  if (count == 0)
  {
    return false;
  }

  const double mean = sum / static_cast<double>(count);
  const double meanSquare = sumSquares / static_cast<double>(count);
  const double acVariance = meanSquare - mean * mean;
  const double acRms = acVariance > 0.0 ? std::sqrt(acVariance) : 0.0;

  float levelDb = kSilenceFloorDb;
  if (acRms > 0.0)
  {
    levelDb = static_cast<float>(20.0 * std::log10(acRms / kAdcReferenceCounts));
    if (levelDb < kSilenceFloorDb)
    {
      levelDb = kSilenceFloorDb;
    }
    else if (levelDb > 0.0f)
    {
      levelDb = 0.0f;
    }
  }

  readings[0] = {'S', levelDb};
  return true;
}
