// Unit conversion from each product's canonical units to display units.
// Canonical: temperature °C, temp difference °C, wind m/s, height dam,
// vorticity 1e-5 s⁻¹, CAPE/CIN J/kg, lapse rate °C/km, height above ground m,
// helicity m²/s², lightning flashes km⁻² (5 min)⁻¹, precip rate mm/h, cloud %, pressure hPa,
// snow/sleet depth cm, ice and precipitation (liquid equivalent) mm,
// reflectivity dBZ, visibility m, probability %; radar: radial velocity / spectrum width m/s, ZDR dB, KDP °/km,
// echo tops km, VIL kg/m².

const KINDS = {
  temp: {
    imperial: { label: '°F', f: (v) => (v * 9) / 5 + 32, inv: (v) => ((v - 32) * 5) / 9 },
    metric: { label: '°C', f: (v) => v, inv: (v) => v },
  },
  tempDelta: {
    imperial: { label: '°F', f: (v) => (v * 9) / 5, inv: (v) => (v * 5) / 9 },
    metric: { label: '°C', f: (v) => v, inv: (v) => v },
  },
  windSfc: {
    imperial: { label: 'mph', f: (v) => v * 2.23694, inv: (v) => v / 2.23694 },
    metric: { label: 'km/h', f: (v) => v * 3.6, inv: (v) => v / 3.6 },
  },
  windUpper: {
    imperial: { label: 'kt', f: (v) => v * 1.943844, inv: (v) => v / 1.943844 },
    metric: { label: 'kt', f: (v) => v * 1.943844, inv: (v) => v / 1.943844 },
  },
  height: { any: { label: 'dam', f: (v) => v, inv: (v) => v } },
  vort: { any: { label: '×10⁻⁵ s⁻¹', f: (v) => v, inv: (v) => v } },
  cape: { any: { label: 'J/kg', f: (v) => v, inv: (v) => v } },
  lapse: { any: { label: '°C/km', f: (v) => v, inv: (v) => v } },
  heightAgl: {
    imperial: { label: 'ft', f: (v) => v * 3.28084, inv: (v) => v / 3.28084 },
    metric: { label: 'm', f: (v) => v, inv: (v) => v },
  },
  index: { any: { label: '', f: (v) => v, inv: (v) => v } },
  srh: { any: { label: 'm²/s²', f: (v) => v, inv: (v) => v } },
  flash: { any: { label: 'fl/km²/5 min', f: (v) => v, inv: (v) => v } },
  rate: {
    imperial: { label: 'in/hr', f: (v) => v / 25.4, inv: (v) => v * 25.4 },
    metric: { label: 'mm/hr', f: (v) => v, inv: (v) => v },
  },
  snow: {
    imperial: { label: 'in', f: (v) => v / 2.54, inv: (v) => v * 2.54 },
    metric: { label: 'cm', f: (v) => v, inv: (v) => v },
  },
  ice: {
    imperial: { label: 'in', f: (v) => v / 25.4, inv: (v) => v * 25.4 },
    metric: { label: 'mm', f: (v) => v, inv: (v) => v },
  },
  dbz: { any: { label: 'dBZ', f: (v) => v, inv: (v) => v } },
  radialVel: {
    imperial: { label: 'kt', f: (v) => v * 1.943844, inv: (v) => v / 1.943844 },
    metric: { label: 'm/s', f: (v) => v, inv: (v) => v },
  },
  db: { any: { label: 'dB', f: (v) => v, inv: (v) => v } },
  ratio: { any: { label: 'ρhv', f: (v) => v, inv: (v) => v } },
  kdp: { any: { label: '°/km', f: (v) => v, inv: (v) => v } },
  hc: { any: { label: 'class', f: (v) => v, inv: (v) => v } },
  echoTop: {
    imperial: { label: 'kft', f: (v) => v * 3.28084, inv: (v) => v / 3.28084 },
    metric: { label: 'km', f: (v) => v, inv: (v) => v },
  },
  vil: { any: { label: 'kg/m²', f: (v) => v, inv: (v) => v } },
  percent: { any: { label: '%', f: (v) => v, inv: (v) => v } },
  vis: {
    imperial: { label: 'mi', f: (v) => v / 1609.344, inv: (v) => v * 1609.344 },
    metric: { label: 'km', f: (v) => v / 1000, inv: (v) => v * 1000 },
  },
  pressure: { any: { label: 'hPa', f: (v) => v, inv: (v) => v } },
};

export function unitFor(kind, system) {
  const k = KINDS[kind];
  return k.any ?? k[system];
}
