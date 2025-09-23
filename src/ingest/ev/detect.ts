// src/ingest/ev/detect.ts
export type EvDetectResult = {
  isElectric: boolean;            // heuristic result
  make?: string;
  model?: string;                 // optional; keep placeholder for later
  smartcarCompatible: boolean;    // heuristic flag only
  batteryEstimateKwh?: number;
  confidence: number;             // 0..1
  source: 'vin_heuristic';
  notes?: string;                 // e.g., "WMI spans EV/ICE for this OEM"
};

const EV_CAPABILITIES: Record<string, { make: string; smartcar: boolean; battery: number; note?: string }> = {
  // IMPORTANT: These are examples. Maintain this map in a config file and keep it updated.
  WDD: { make: 'Mercedes-Benz', smartcar: true,  battery: 80 }, // many EQ models
  WBA: { make: 'BMW',           smartcar: true,  battery: 85 }, // i4/iX families
  //TYJ: { make: 'Tesla',         smartcar: true,  battery: 75 }, // Model 3/Y
  WVW: { make: 'Volkswagen',    smartcar: true,  battery: 77 }, // ID.4/ID.3 (region-dependent)
  // NOTE: BYD examples often start with "LGX..." (China WMI). Verify locally and add real WMIs you see.
  LGX: { make: 'BYD',          smartcar: false, battery: 60, note: 'Verify WMI for ZA imports' },
};

export function detectEVFromVin(vinRaw: string): EvDetectResult {
  const vin = (vinRaw || '').trim()
  if (vin.length !== 17) {
    return {
      isElectric: false,
      smartcarCompatible: false,
      confidence: 0,
      source: 'vin_heuristic',
      notes: 'invalid_vin_length',
    };
  }

  const wmi = vin.substring(0, 3);
  const match = EV_CAPABILITIES[wmi];

  // Heuristic: WMI match suggests EV-likely, but can be mixed (OEMs share WMI across ICE/EV).
  const isElectric = !!match;
  const confidence = match ? 0.7 : 0; // start conservative; you can raise for EV-only WMIs you confirm

  return {
    isElectric,
    make: match?.make,
    model: undefined, // optional enhancement later via DB/decoder
    smartcarCompatible: match?.smartcar ?? false,
    batteryEstimateKwh: match?.battery,
    confidence,
    source: 'vin_heuristic',
    notes: match?.note,
  };
}
