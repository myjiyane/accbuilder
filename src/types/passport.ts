export type OdometerSource = 'DEKRA' | 'photo_only' | 'n/a';
export type DtcStatus = 'green' | 'amber' | 'red' | 'n/a';

export interface DtcCode {
  code: string;       // e.g., P0420
  desc?: string;
}

export interface PassportBase {
  vin: string;        // 17-char VIN
  lot_id: string;
  dekra?: {
    url?: string;
    report_id?: string;
    inspection_ts?: string; // ISO8601
    site?: string;
  };
  odometer?: {
    km?: number | null;
    source?: OdometerSource;
  };
  tyres_mm?: {
    fl?: number | null;
    fr?: number | null;
    rl?: number | null;
    rr?: number | null;
  };
  brakes?: {
    front_pct?: number | null;
    rear_pct?: number | null;
    notes?: string;
  };
  dtc?: {
    status?: DtcStatus;
    codes?: DtcCode[];
  };
  remarks?: string;
  provenance: {
    captured_by: string; // staff id or 'system'
    site?: string;
    ts: string;          // ISO8601
  };
}

export interface PassportSealed extends PassportBase {
  seal: {
    hash: string;      // hex(sha256)
    sig: string;       // base64 signature
    key_id: string;    // key alias or arn
    sealed_ts: string; // ISO8601
  };
}

export type PassportDraft = PassportBase; // no seal yet