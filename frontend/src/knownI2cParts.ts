/**
 * Frontend-only I2C badge heuristic for the Detected Components list.
 *
 * There is no detector-provided field for "this component communicates over
 * I2C" — `type` is a closed set of physical categories (resistor, ic,
 * ...) and `label` is Gemini's open-vocabulary guess at what the part
 * physically IS, decided from visual evidence alone (shape, pins, package).
 * I2C-ness is an electrical/protocol property, not something visible in a
 * photo, so neither field can carry it.
 *
 * What CAN carry it is the printed marking (`name` — the part number read
 * off the component), matched here against a small, manually maintained
 * list of common I2C part numbers/prefixes. This is necessarily incomplete —
 * any I2C part not in this list won't get the badge — but it's the only
 * signal available without touching detection or the backend.
 */

// Common I2C-bus parts likely to show up on a salvaged board: I/O expanders,
// RTCs, EEPROMs, IMUs/sensors, and other well-known I2C peripheral families.
// Matched as a case-insensitive substring against the component's printed
// marking, so e.g. "PCF8574T" and "PCF8574AN" both match "PCF8574".
const KNOWN_I2C_PART_PREFIXES: readonly string[] = [
  "PCF8574", // I/O expander
  "PCF8575", // I/O expander
  "MCP23008", // I/O expander
  "MCP23017", // I/O expander
  "DS1307", // RTC
  "DS3231", // RTC
  "PCF8563", // RTC
  "24LC", // EEPROM family (24LC256, 24LC512, ...)
  "24C0", // EEPROM family (24C02, 24C04, ...)
  "AT24C", // EEPROM family
  "MPU6050", // IMU
  "MPU9250", // IMU
  "BMP280", // pressure sensor
  "BME280", // pressure/humidity sensor
  "ADS1115", // ADC
  "ADS1015", // ADC
  "SSD1306", // OLED display controller
  "PCA9685", // PWM driver
  "INA219", // current/power sensor
  "SHT31", // temperature/humidity sensor
  "HTU21D", // temperature/humidity sensor
  "TCA9548", // I2C multiplexer
];

/** True when a component's printed marking matches a known I2C part. */
export function isKnownI2cComponent(component: { name: string | null }): boolean {
  const marking = component.name?.toUpperCase() ?? "";
  if (!marking) {
    return false;
  }
  return KNOWN_I2C_PART_PREFIXES.some((prefix) => marking.includes(prefix));
}
