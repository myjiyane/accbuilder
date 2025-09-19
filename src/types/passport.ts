export type OdometerSource = 'DEKRA' | 'photo_only' | 'n/a';
export type DtcStatus = 'green' | 'amber' | 'red' | 'n/a';

export interface DtcCode {
  code: string;       // e.g., P0420
  desc?: string;
}

// ---- Image manifest (for intake photos) ----
export type ImageRole =
  | 'exterior_front_34'
  | 'exterior_rear_34'
  | 'left_side'
  | 'right_side'
  | 'interior_front'
  | 'interior_rear'
  | 'dash_odo'
  | 'engine_bay'
  | 'tyre_fl'
  | 'tyre_fr'
  | 'tyre_rl'
  | 'tyre_rr';

export interface ImageItem {
  role: ImageRole;        // semantic slot
  url?: string;           // public or signed URL (dev: /uploads/..)
  object_key?: string;    // S3 key or local key
  sha256?: string;        // hex, for integrity
  w?: number;             // width px
  h?: number;             // height px
  captured_ts?: string;   // ISO8601
}

export interface ImagesManifest {
  required?: ImageRole[]; // required roles (seeded)
  items: ImageItem[];     // captured photos
}


export interface PassportBase {
  vin: string;        
  lot_id: string;
  dekra?: {
    url?: string;
    report_id?: string;
    inspection_ts?: string;
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
  images?: ImagesManifest;
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