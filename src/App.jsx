import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Search, SlidersHorizontal, X, Heart, Share2, Scale, ChevronRight,
  Star, Moon, Sun, Smartphone, Layers, Settings as SettingsIcon,
  Plus, Check, ArrowLeft, Gauge, BatteryCharging, Camera, Cpu, Wifi,
  LayoutGrid, FolderPlus, Folder, Trash2, Loader2, Sparkles, Info,
  RotateCcw, MessageCircle, MessageSquare, Mail, Send, AtSign, Globe, Copy,
} from 'lucide-react';
import { storage } from './lib/storage';
import { DEVICE_SOURCE, API_BASE_URL, fetchDevicesFromApi } from './lib/api';

/* ============================================================================
   XENVIA — Device Encyclopedia & Discovery Platform
   ----------------------------------------------------------------------------
   Data flow:  RAW_DEVICES -> validate -> normalize -> deduplicate -> MASTER
               MASTER -> search -> filter -> sort -> paginate -> render
   Single source of truth: MASTER_DEVICES (built once, memoized).
   Catalogue, Search, Details, Wishlist, Collections and Compare all read
   the same records by stable id — nothing is copied or forked.
   ============================================================================ */

// ---------------------------------------------------------------------------
// Feature flags — AI is intentionally paused. No AI module is initialized,
// no AI network calls are made, and nothing in the core encyclopedia depends
// on it. Flip this to true (and wire AiService.init()) to enable it later.
// ---------------------------------------------------------------------------
const AI_FEATURES_ENABLED = false;

const AiService = {
  init() { /* no-op while AI_FEATURES_ENABLED is false */ },
  isEnabled() { return AI_FEATURES_ENABLED; },
};

// ---------------------------------------------------------------------------
// LIVE DATA SYNC — architecture for the requested daily 3AM refresh.
// -----------------------------------------------------------------------
// IMPORTANT / HONEST LIMITATION: a Claude Artifact runs entirely client-side
// in the person's browser. It has no server process, no filesystem, and no
// scheduler — so it cannot itself run a cron job, cannot scrape third-party
// sites on a timer, and cannot hold credentials. None of that is something
// this file (or any browser artifact) can do; it needs a small always-on
// service outside this environment. What *is* built here is the production
// architecture for that pipeline — feature-flagged off, same pattern as the
// AI module above — so a real backend can be dropped in without touching
// the UI: the UI only ever reads MASTER_DEVICES, however it was populated.
//
// Intended production design (to run on a small Node/serverless job — e.g.
// a scheduled GitHub Action, Vercel Cron, or AWS Lambda + EventBridge):
//   Schedule   : "0 3 * * *"  (03:00 daily)
//   Sources    : DATA_SOURCES below, in priority order per field
//   Ingestion  : any device with a release date in the last CATALOG_WINDOW_YEARS
//                years is in-window; freshly announced devices (as of "day-1",
//                the day after release) are pulled in on the next run
//   Pipeline   : scrape -> validate -> normalize -> deduplicate (reuses the
//                exact same functions this file already uses for the bundled
//                dataset) -> write to a real database -> app fetches from an API
//   Note       : scraping GSM Arena / WhatMobile / retailer sites is subject to
//                each site's Terms of Service and robots.txt — a production
//                build should confirm allowed use or use official APIs/feeds
//                where the source provides one before scraping at scale.
// ---------------------------------------------------------------------------
const LIVE_SYNC_ENABLED = false;
const CATALOG_WINDOW_YEARS = 5; // rolling window: yesterday back this many years
const SYNC_SCHEDULE_CRON = '0 3 * * *';
const DATA_SOURCES = [
  { id: 'official', name: 'Official manufacturer sites', role: 'primary', kind: 'specs' },
  { id: 'priceoye', name: 'PriceOye.pk', role: 'primary', kind: 'pricing' },
  { id: 'gsmarena', name: 'GSM Arena', role: 'fallback', kind: 'specs+pricing' },
  { id: 'whatmobile', name: 'WhatMobile', role: 'fallback', kind: 'pricing' },
];

const DataSyncService = {
  isEnabled() { return LIVE_SYNC_ENABLED; },
  schedule() { return SYNC_SCHEDULE_CRON; },
  sources() { return DATA_SOURCES; },
  windowYears() { return CATALOG_WINDOW_YEARS; },
  // In production: runs on the schedule above, scrapes each source, then
  // pipes results through validateDevice -> normalizeDevice -> buildCatalog
  // (the same functions below) so live data and bundled data behave
  // identically to the rest of the app. No-op while disabled.
  async runDailySync() { if (!LIVE_SYNC_ENABLED) return { ran: false, reason: 'LIVE_SYNC_ENABLED is false' }; },
  lastSyncedLabel() { return LIVE_SYNC_ENABLED ? 'Synced' : 'Using bundled sample data (live sync not connected)'; },
};

function catalogWindowFloorYear() { return new Date().getFullYear() - CATALOG_WINDOW_YEARS; }

// ---------------------------------------------------------------------------
// Design-token accent ring used for device art (not literal brand colors)
// ---------------------------------------------------------------------------
const ACCENT_RING = ['#5B8CFF', '#22C1B8', '#FFB648', '#FF6B81', '#8C7CF0', '#3AC7A0', '#4FA8E0', '#FF9F4A', '#C46BFF', '#5FD1C9'];

const BRAND_POPULARITY = ['Samsung', 'Apple', 'Xiaomi', 'Google', 'OnePlus', 'Oppo', 'Vivo', 'Realme', 'Honor', 'Huawei', 'Infinix', 'Tecno', 'Motorola', 'Nothing', 'Asus', 'Sony', 'ZTE', 'Nokia', 'itel', 'Lenovo'];

const CATEGORY_LABELS = { flagship: 'Flagship', midrange: 'Midrange', budget: 'Budget', gaming: 'Gaming', foldable: 'Foldable' };

const GAMING_COLORS = { Excellent: '#4ADE80', Great: '#5B8CFF', Good: '#FFB648', Moderate: '#FF9F4A', Challenging: '#FB7185' };

// ---------------------------------------------------------------------------
// RAW DEVICE CONFIG — single source of truth for device data.
// Adding a device is adding one line here; no UI code changes needed.
// Illustrative sample data (specs/pricing), PKR-denominated, resolved with
// priceoye.pk given top priority per the pricing methodology below.
// b=brand m=model mn=modelNumber y=year cat=category dsize/dtype/refresh/res=display
// chip/gpu=silicon batt/chg=battery cam=[main,ultrawide,tele] camf=front camera
// ramOpts/romOpts=variant memory options price0/priceStep=variant pricing
// os/net=software+network wt/dim=build colors=available colorways
// ---------------------------------------------------------------------------
const RAW_DEVICES = [
  // Apple
  { b: 'Apple', m: 'iPhone 11', mn: 'A2111', y: 2019, cat: 'midrange', dsize: 6.1, dtype: 'Liquid Retina LCD', refresh: 60, res: '1792x828', chip: 'Apple A13 Bionic', gpu: 'Apple GPU (4-core)', batt: 3110, chg: 18, cam: [12, 12], camf: 12, ramOpts: [4], romOpts: [64, 128, 256], price0: 99999, priceStep: 15000, os: 'iOS 17', net: '4G', wt: 194, dim: '150.9×75.7×8.3mm', colors: ['Black', 'White', 'Green', 'Purple', 'Red'] },
  { b: 'Apple', m: 'iPhone 12', mn: 'A2172', y: 2020, cat: 'midrange', dsize: 6.1, dtype: 'Super Retina XDR OLED', refresh: 60, res: '2532x1170', chip: 'Apple A14 Bionic', gpu: 'Apple GPU (4-core)', batt: 2815, chg: 20, cam: [12, 12], camf: 12, ramOpts: [4], romOpts: [64, 128, 256], price0: 139999, priceStep: 18000, os: 'iOS 17', net: '5G', wt: 164, dim: '146.7×71.5×7.4mm', colors: ['Black', 'White', 'Blue', 'Green', 'Red'] },
  { b: 'Apple', m: 'iPhone 13', mn: 'A2482', y: 2021, cat: 'midrange', dsize: 6.1, dtype: 'Super Retina XDR OLED', refresh: 60, res: '2532x1170', chip: 'Apple A15 Bionic', gpu: 'Apple GPU (4-core)', batt: 3240, chg: 20, cam: [12, 12], camf: 12, ramOpts: [4], romOpts: [128, 256, 512], price0: 179999, priceStep: 25000, os: 'iOS 17', net: '5G', wt: 173, dim: '146.7×71.5×7.65mm', colors: ['Midnight', 'Starlight', 'Blue', 'Pink', 'Red'] },
  { b: 'Apple', m: 'iPhone 14', mn: 'A2649', y: 2022, cat: 'midrange', dsize: 6.1, dtype: 'Super Retina XDR OLED', refresh: 60, res: '2532x1170', chip: 'Apple A15 Bionic', gpu: 'Apple GPU (5-core)', batt: 3279, chg: 20, cam: [12, 12], camf: 12, ramOpts: [6], romOpts: [128, 256, 512], price0: 219999, priceStep: 28000, os: 'iOS 17', net: '5G', wt: 172, dim: '146.7×71.5×7.8mm', colors: ['Midnight', 'Starlight', 'Blue', 'Purple', 'Yellow'] },
  { b: 'Apple', m: 'iPhone 14 Pro', mn: 'A2650', y: 2022, cat: 'flagship', dsize: 6.1, dtype: 'Super Retina XDR OLED ProMotion', refresh: 120, res: '2556x1179', chip: 'Apple A16 Bionic', gpu: 'Apple GPU (5-core)', batt: 3200, chg: 27, cam: [48, 12, 12], camf: 12, ramOpts: [6], romOpts: [128, 256, 512, 1024], price0: 329999, priceStep: 30000, os: 'iOS 17', net: '5G', wt: 206, dim: '147.5×71.5×7.85mm', colors: ['Space Black', 'Silver', 'Gold', 'Deep Purple'] },
  { b: 'Apple', m: 'iPhone 15', mn: 'A3090', y: 2023, cat: 'midrange', dsize: 6.1, dtype: 'Super Retina XDR OLED', refresh: 60, res: '2556x1179', chip: 'Apple A16 Bionic', gpu: 'Apple GPU (5-core)', batt: 3349, chg: 20, cam: [48, 12], camf: 12, ramOpts: [6], romOpts: [128, 256, 512], price0: 249999, priceStep: 30000, os: 'iOS 17', net: '5G', wt: 171, dim: '147.6×71.6×7.8mm', colors: ['Black', 'Blue', 'Green', 'Yellow', 'Pink'] },
  { b: 'Apple', m: 'iPhone 15 Pro', mn: 'A3101', y: 2023, cat: 'flagship', dsize: 6.1, dtype: 'Super Retina XDR OLED ProMotion', refresh: 120, res: '2556x1179', chip: 'Apple A17 Pro', gpu: 'Apple GPU (6-core)', batt: 3274, chg: 27, cam: [48, 12, 12], camf: 12, ramOpts: [8], romOpts: [128, 256, 512, 1024], price0: 379999, priceStep: 35000, os: 'iOS 17', net: '5G', wt: 187, dim: '146.6×70.6×8.25mm', colors: ['Natural Titanium', 'Blue Titanium', 'White Titanium', 'Black Titanium'] },
  { b: 'Apple', m: 'iPhone 16 Pro Max', mn: 'A3084', y: 2024, cat: 'flagship', dsize: 6.9, dtype: 'Super Retina XDR OLED ProMotion', refresh: 120, res: '2868x1320', chip: 'Apple A18 Pro', gpu: 'Apple GPU (6-core)', batt: 4685, chg: 27, cam: [48, 48, 12], camf: 12, ramOpts: [8], romOpts: [256, 512, 1024], price0: 499999, priceStep: 45000, os: 'iOS 18', net: '5G', wt: 227, dim: '163.0×77.6×8.25mm', colors: ['Black Titanium', 'White Titanium', 'Natural Titanium', 'Desert Titanium'] },
  // Samsung
  { b: 'Samsung', m: 'Galaxy S21', mn: 'SM-G991B', y: 2021, cat: 'flagship', dsize: 6.2, dtype: 'Dynamic AMOLED 2X', refresh: 120, res: '2400x1080', chip: 'Snapdragon 888', gpu: 'Adreno 660', batt: 4000, chg: 25, cam: [12, 12, 64], camf: 10, ramOpts: [8], romOpts: [128, 256], price0: 149999, priceStep: 20000, os: 'Android 14, One UI 6.1', net: '5G', wt: 169, dim: '151.7×71.2×7.9mm', colors: ['Phantom Gray', 'Phantom White', 'Phantom Violet', 'Phantom Pink'] },
  { b: 'Samsung', m: 'Galaxy S22', mn: 'SM-S901B', y: 2022, cat: 'flagship', dsize: 6.1, dtype: 'Dynamic AMOLED 2X', refresh: 120, res: '2340x1080', chip: 'Snapdragon 8 Gen 1', gpu: 'Adreno 730', batt: 3700, chg: 25, cam: [50, 12, 10], camf: 10, ramOpts: [8], romOpts: [128, 256], price0: 189999, priceStep: 22000, os: 'Android 14, One UI 6.1', net: '5G', wt: 167, dim: '146.0×70.6×7.6mm', colors: ['Phantom Black', 'Phantom White', 'Pink Gold', 'Green'] },
  { b: 'Samsung', m: 'Galaxy S23', mn: 'SM-S911B', y: 2023, cat: 'flagship', dsize: 6.1, dtype: 'Dynamic AMOLED 2X', refresh: 120, res: '2340x1080', chip: 'Snapdragon 8 Gen 2 for Galaxy', gpu: 'Adreno 740', batt: 3900, chg: 25, cam: [50, 12, 10], camf: 12, ramOpts: [8], romOpts: [128, 256, 512], price0: 239999, priceStep: 25000, os: 'Android 14, One UI 6.1', net: '5G', wt: 168, dim: '146.3×70.9×7.6mm', colors: ['Phantom Black', 'Cream', 'Green', 'Lavender'] },
  { b: 'Samsung', m: 'Galaxy S24', mn: 'SM-S921B', y: 2024, cat: 'flagship', dsize: 6.2, dtype: 'Dynamic AMOLED 2X', refresh: 120, res: '2340x1080', chip: 'Snapdragon 8 Gen 3 for Galaxy', gpu: 'Adreno 750', batt: 4000, chg: 25, cam: [50, 12, 10], camf: 12, ramOpts: [8], romOpts: [128, 256, 512], price0: 279999, priceStep: 28000, os: 'Android 14, One UI 6.1', net: '5G', wt: 167, dim: '147.0×70.6×7.6mm', colors: ['Onyx Black', 'Marble Gray', 'Cobalt Violet', 'Amber Yellow'] },
  { b: 'Samsung', m: 'Galaxy S24 Ultra', mn: 'SM-S928B', y: 2024, cat: 'flagship', dsize: 6.8, dtype: 'Dynamic AMOLED 2X', refresh: 120, res: '3120x1440', chip: 'Snapdragon 8 Gen 3 for Galaxy', gpu: 'Adreno 750', batt: 5000, chg: 45, cam: [200, 12, 50], camf: 12, ramOpts: [12], romOpts: [256, 512, 1024], price0: 399999, priceStep: 55000, os: 'Android 14, One UI 6.1', net: '5G', wt: 232, dim: '162.3×79.0×8.6mm', colors: ['Titanium Black', 'Titanium Gray', 'Titanium Violet', 'Titanium Yellow'] },
  { b: 'Samsung', m: 'Galaxy A54', mn: 'SM-A546B', y: 2023, cat: 'midrange', dsize: 6.4, dtype: 'Super AMOLED', refresh: 120, res: '2340x1080', chip: 'Exynos 1380', gpu: 'Mali-G68', batt: 5000, chg: 25, cam: [50, 12, 5], camf: 32, ramOpts: [8], romOpts: [128, 256], price0: 89999, priceStep: 12000, os: 'Android 14, One UI 6.1', net: '5G', wt: 202, dim: '158.2×76.7×8.2mm', colors: ['Awesome Black', 'Awesome White', 'Awesome Violet', 'Awesome Lime'] },
  { b: 'Samsung', m: 'Galaxy A34', mn: 'SM-A346B', y: 2023, cat: 'midrange', dsize: 6.6, dtype: 'Super AMOLED', refresh: 120, res: '2340x1080', chip: 'Dimensity 1080', gpu: 'Mali-G68', batt: 5000, chg: 25, cam: [48, 8, 5], camf: 13, ramOpts: [8], romOpts: [128, 256], price0: 69999, priceStep: 10000, os: 'Android 14, One UI 6.1', net: '5G', wt: 199, dim: '161.3×78.1×8.2mm', colors: ['Awesome Graphite', 'Awesome Silver', 'Awesome Violet', 'Awesome Lime'] },
  { b: 'Samsung', m: 'Galaxy Z Flip5', mn: 'SM-F731B', y: 2023, cat: 'foldable', dsize: 6.7, dtype: 'Foldable Dynamic AMOLED 2X', refresh: 120, res: '2640x1080', chip: 'Snapdragon 8 Gen 2 for Galaxy', gpu: 'Adreno 740', batt: 3700, chg: 25, cam: [12, 12], camf: 10, ramOpts: [8], romOpts: [256, 512], price0: 379999, priceStep: 40000, os: 'Android 14, One UI 6.1', net: '5G', wt: 187, dim: '165.1×71.9×6.9mm (unfolded)', colors: ['Mint', 'Graphite', 'Cream', 'Lavender'] },
  { b: 'Samsung', m: 'Galaxy Z Fold5', mn: 'SM-F946B', y: 2023, cat: 'foldable', dsize: 7.6, dtype: 'Foldable Dynamic AMOLED 2X', refresh: 120, res: '2176x1812', chip: 'Snapdragon 8 Gen 2 for Galaxy', gpu: 'Adreno 740', batt: 4400, chg: 25, cam: [50, 12, 10], camf: 10, ramOpts: [12], romOpts: [256, 512, 1024], price0: 549999, priceStep: 60000, os: 'Android 14, One UI 6.1', net: '5G', wt: 253, dim: '154.9×129.9×6.1mm (unfolded)', colors: ['Icy Blue', 'Phantom Black', 'Cream'] },
  { b: 'Samsung', m: 'Galaxy M14', mn: 'SM-M146B', y: 2023, cat: 'budget', dsize: 6.6, dtype: 'PLS LCD', refresh: 90, res: '2408x1080', chip: 'Exynos 1330', gpu: 'Mali-G68', batt: 6000, chg: 25, cam: [50, 2, 2], camf: 13, ramOpts: [4, 6], romOpts: [64, 128], price0: 34999, priceStep: 6000, os: 'Android 13, One UI 5.1', net: '5G', wt: 206, dim: '168.3×78.0×9.1mm', colors: ['Icy Silver', 'Berry Blue', 'Arctic Blue'] },
  // Google
  { b: 'Google', m: 'Pixel 6', mn: 'GB7N6', y: 2021, cat: 'flagship', dsize: 6.4, dtype: 'OLED', refresh: 90, res: '2400x1080', chip: 'Google Tensor', gpu: 'Mali-G78', batt: 4614, chg: 30, cam: [50, 12], camf: 8, ramOpts: [8], romOpts: [128, 256], price0: 129999, priceStep: 18000, os: 'Android 14', net: '5G', wt: 207, dim: '158.6×74.8×8.9mm', colors: ['Stormy Black', 'Sorta Seafoam', 'Kinda Coral'] },
  { b: 'Google', m: 'Pixel 6a', mn: 'GX7AS', y: 2022, cat: 'midrange', dsize: 6.1, dtype: 'OLED', refresh: 60, res: '2400x1080', chip: 'Google Tensor', gpu: 'Mali-G78', batt: 4306, chg: 18, cam: [12, 12], camf: 8, ramOpts: [6], romOpts: [128], price0: 74999, priceStep: 0, os: 'Android 14', net: '5G', wt: 178, dim: '152.2×71.8×8.9mm', colors: ['Charcoal', 'Chalk', 'Sage'] },
  { b: 'Google', m: 'Pixel 7', mn: 'GVU6C', y: 2022, cat: 'flagship', dsize: 6.3, dtype: 'OLED', refresh: 90, res: '2400x1080', chip: 'Google Tensor G2', gpu: 'Mali-G710', batt: 4355, chg: 30, cam: [50, 12], camf: 10.8, ramOpts: [8], romOpts: [128, 256], price0: 149999, priceStep: 20000, os: 'Android 14', net: '5G', wt: 197, dim: '155.6×73.2×8.7mm', colors: ['Obsidian', 'Snow', 'Lemongrass'] },
  { b: 'Google', m: 'Pixel 7 Pro', mn: 'GE2AE', y: 2022, cat: 'flagship', dsize: 6.7, dtype: 'LTPO OLED', refresh: 120, res: '3120x1440', chip: 'Google Tensor G2', gpu: 'Mali-G710', batt: 5000, chg: 30, cam: [50, 48, 12], camf: 10.8, ramOpts: [12], romOpts: [128, 256, 512], price0: 199999, priceStep: 22000, os: 'Android 14', net: '5G', wt: 212, dim: '162.9×76.6×8.9mm', colors: ['Obsidian', 'Snow', 'Hazel'] },
  { b: 'Google', m: 'Pixel 8', mn: 'GKWS6', y: 2023, cat: 'flagship', dsize: 6.2, dtype: 'OLED', refresh: 120, res: '2400x1080', chip: 'Google Tensor G3', gpu: 'Mali-G715', batt: 4575, chg: 27, cam: [50, 12], camf: 10.5, ramOpts: [8], romOpts: [128, 256], price0: 219999, priceStep: 25000, os: 'Android 14', net: '5G', wt: 187, dim: '150.5×70.8×8.9mm', colors: ['Obsidian', 'Hazel', 'Rose'] },
  { b: 'Google', m: 'Pixel 8 Pro', mn: 'GC3VE', y: 2023, cat: 'flagship', dsize: 6.7, dtype: 'LTPO OLED', refresh: 120, res: '2992x1344', chip: 'Google Tensor G3', gpu: 'Mali-G715', batt: 5050, chg: 30, cam: [50, 48, 48], camf: 10.5, ramOpts: [12], romOpts: [128, 256, 512, 1024], price0: 279999, priceStep: 28000, os: 'Android 14', net: '5G', wt: 213, dim: '162.6×76.5×8.8mm', colors: ['Obsidian', 'Porcelain', 'Bay'] },
  // Xiaomi
  { b: 'Xiaomi', m: 'Redmi Note 12', mn: '22111317I', y: 2023, cat: 'midrange', dsize: 6.67, dtype: 'AMOLED', refresh: 120, res: '2400x1080', chip: 'Snapdragon 685', gpu: 'Adreno 610', batt: 5000, chg: 33, cam: [48, 8, 2], camf: 13, ramOpts: [4, 6, 8], romOpts: [128, 128, 256], price0: 44999, priceStep: 8000, os: 'Android 13, MIUI 14', net: '4G', wt: 183, dim: '165.9×76.2×7.8mm', colors: ['Onyx Gray', 'Ice Blue', 'Mint Green'] },
  { b: 'Xiaomi', m: 'Redmi Note 13 Pro', mn: '23090RA98I', y: 2023, cat: 'midrange', dsize: 6.67, dtype: 'AMOLED', refresh: 120, res: '2400x1080', chip: 'Snapdragon 7s Gen 2', gpu: 'Adreno 710', batt: 5100, chg: 67, cam: [200, 8, 2], camf: 16, ramOpts: [8, 12], romOpts: [256, 512], price0: 69999, priceStep: 12000, os: 'Android 13, MIUI 14', net: '5G', wt: 187, dim: '161.1×74.2×7.98mm', colors: ['Midnight Black', 'Lavender Purple', 'Coral Purple'] },
  { b: 'Xiaomi', m: 'Redmi 13C', mn: '23129RAA4I', y: 2023, cat: 'budget', dsize: 6.74, dtype: 'IPS LCD', refresh: 90, res: '2400x1080', chip: 'MediaTek Helio G85', gpu: 'Mali-G52', batt: 5000, chg: 18, cam: [50, 2], camf: 8, ramOpts: [4, 6, 8], romOpts: [128, 128, 256], price0: 24999, priceStep: 4000, os: 'Android 13', net: '4G', wt: 192, dim: '168.4×76.3×8.1mm', colors: ['Midnight Black', 'Glacier White', 'Navy Blue'] },
  { b: 'Xiaomi', m: 'Xiaomi 13', mn: '2211133C', y: 2022, cat: 'flagship', dsize: 6.36, dtype: 'AMOLED', refresh: 120, res: '2400x1080', chip: 'Snapdragon 8 Gen 2', gpu: 'Adreno 740', batt: 4500, chg: 67, cam: [50, 12, 10], camf: 32, ramOpts: [8, 12], romOpts: [256, 512], price0: 189999, priceStep: 25000, os: 'Android 13, MIUI 14', net: '5G', wt: 189, dim: '152.8×71.5×8.0mm', colors: ['Black', 'White', 'Flora Green'] },
  { b: 'Xiaomi', m: 'Xiaomi 14', mn: '23127PN0CC', y: 2023, cat: 'flagship', dsize: 6.36, dtype: 'AMOLED', refresh: 120, res: '2670x1200', chip: 'Snapdragon 8 Gen 3', gpu: 'Adreno 750', batt: 4610, chg: 90, cam: [50, 50, 50], camf: 32, ramOpts: [12], romOpts: [256, 512], price0: 259999, priceStep: 30000, os: 'Android 14, HyperOS', net: '5G', wt: 188, dim: '152.8×71.5×8.2mm', colors: ['Black', 'White', 'Jade Green'] },
  { b: 'Xiaomi', m: 'Poco X6 Pro', mn: '23122PCD1G', y: 2024, cat: 'midrange', dsize: 6.67, dtype: 'AMOLED', refresh: 120, res: '2712x1220', chip: 'Dimensity 8300 Ultra', gpu: 'Mali-G615', batt: 5000, chg: 67, cam: [64, 8, 2], camf: 16, ramOpts: [8, 12], romOpts: [256, 512], price0: 64999, priceStep: 12000, os: 'Android 14, HyperOS', net: '5G', wt: 186, dim: '161.4×74.9×8.0mm', colors: ['Black', 'Yellow', 'Gray'] },
  { b: 'Xiaomi', m: 'Poco F6', mn: '24069PC21G', y: 2024, cat: 'flagship', dsize: 6.67, dtype: 'AMOLED', refresh: 120, res: '2712x1220', chip: 'Snapdragon 8s Gen 3', gpu: 'Adreno 735', batt: 5000, chg: 90, cam: [50, 8], camf: 20, ramOpts: [8, 12], romOpts: [256, 512], price0: 84999, priceStep: 15000, os: 'Android 14, HyperOS', net: '5G', wt: 179, dim: '160.5×74.7×7.8mm', colors: ['Titanium Black', 'Titanium Violet'] },
  { b: 'Xiaomi', m: 'Poco M6 Pro', mn: '23122PC61G', y: 2024, cat: 'budget', dsize: 6.67, dtype: 'AMOLED', refresh: 120, res: '2400x1080', chip: 'MediaTek Helio G99 Ultra', gpu: 'Mali-G57', batt: 5000, chg: 67, cam: [64, 2], camf: 16, ramOpts: [6, 8], romOpts: [128, 256], price0: 39999, priceStep: 7000, os: 'Android 14', net: '4G', wt: 181, dim: '161.2×74.7×8.1mm', colors: ['Forest Green', 'Power Black'] },
  // OnePlus
  { b: 'OnePlus', m: 'Nord CE3', mn: 'CPH2465', y: 2023, cat: 'midrange', dsize: 6.7, dtype: 'AMOLED', refresh: 120, res: '2412x1080', chip: 'Snapdragon 782G', gpu: 'Adreno 642L', batt: 5000, chg: 80, cam: [50, 2, 2], camf: 16, ramOpts: [8, 12], romOpts: [128, 256], price0: 74999, priceStep: 12000, os: 'Android 13, OxygenOS', net: '5G', wt: 186, dim: '162.9×75.1×8.0mm', colors: ['Aqua Surge', 'Grey Shimmer'] },
  { b: 'OnePlus', m: 'Nord 3', mn: 'CPH2493', y: 2023, cat: 'midrange', dsize: 6.74, dtype: 'AMOLED', refresh: 120, res: '2772x1240', chip: 'Dimensity 9000', gpu: 'Mali-G710', batt: 5000, chg: 80, cam: [50, 8, 2], camf: 16, ramOpts: [8, 16], romOpts: [128, 256], price0: 99999, priceStep: 15000, os: 'Android 13, OxygenOS', net: '5G', wt: 193, dim: '162.6×75.0×8.2mm', colors: ['Misty Green', 'Tempest Gray'] },
  { b: 'OnePlus', m: 'OnePlus 11', mn: 'CPH2449', y: 2023, cat: 'flagship', dsize: 6.7, dtype: 'LTPO AMOLED', refresh: 120, res: '3216x1440', chip: 'Snapdragon 8 Gen 2', gpu: 'Adreno 740', batt: 5000, chg: 100, cam: [50, 48, 32], camf: 16, ramOpts: [8, 16], romOpts: [128, 256, 512], price0: 194999, priceStep: 22000, os: 'Android 14, OxygenOS', net: '5G', wt: 205, dim: '163.1×74.1×8.5mm', colors: ['Titan Black', 'Eternal Green'] },
  { b: 'OnePlus', m: 'OnePlus 12', mn: 'CPH2583', y: 2024, cat: 'flagship', dsize: 6.82, dtype: 'LTPO AMOLED', refresh: 120, res: '3168x1440', chip: 'Snapdragon 8 Gen 3', gpu: 'Adreno 750', batt: 5400, chg: 100, cam: [50, 64, 48], camf: 32, ramOpts: [12, 16], romOpts: [256, 512], price0: 249999, priceStep: 28000, os: 'Android 14, OxygenOS', net: '5G', wt: 220, dim: '164.3×75.8×9.15mm', colors: ['Silky Black', 'Flowy Emerald'] },
  { b: 'OnePlus', m: 'OnePlus 12R', mn: 'CPH2609', y: 2024, cat: 'midrange', dsize: 6.78, dtype: 'AMOLED', refresh: 120, res: '2780x1264', chip: 'Snapdragon 8 Gen 2', gpu: 'Adreno 740', batt: 5500, chg: 100, cam: [50, 8], camf: 16, ramOpts: [8, 16], romOpts: [128, 256], price0: 134999, priceStep: 18000, os: 'Android 14, OxygenOS', net: '5G', wt: 207, dim: '163.3×75.3×8.8mm', colors: ['Iron Gray', 'Cool Blue'] },
  { b: 'OnePlus', m: 'OnePlus Open', mn: 'CPH2551', y: 2023, cat: 'foldable', dsize: 7.82, dtype: 'LTPO AMOLED', refresh: 120, res: '2268x2440', chip: 'Snapdragon 8 Gen 2', gpu: 'Adreno 740', batt: 4805, chg: 67, cam: [48, 64, 48], camf: 20, ramOpts: [16], romOpts: [512], price0: 469999, priceStep: 0, os: 'Android 13, OxygenOS', net: '5G', wt: 245, dim: '153.4×143.1×5.8mm (unfolded)', colors: ['Voyager Black', 'Emerald Dusk'] },
  // Oppo
  { b: 'Oppo', m: 'Reno 10', mn: 'CPH2531', y: 2023, cat: 'midrange', dsize: 6.7, dtype: 'AMOLED', refresh: 120, res: '2412x1080', chip: 'Dimensity 7050', gpu: 'Mali-G68', batt: 5000, chg: 67, cam: [64, 8, 2], camf: 32, ramOpts: [8, 12], romOpts: [128, 256], price0: 79999, priceStep: 12000, os: 'Android 13, ColorOS', net: '5G', wt: 185, dim: '161.4×73.9×7.9mm', colors: ['Silvery Grey', 'Ice Blue'] },
  { b: 'Oppo', m: 'Reno 11', mn: 'CPH2603', y: 2024, cat: 'midrange', dsize: 6.7, dtype: 'AMOLED', refresh: 120, res: '2412x1080', chip: 'Dimensity 7050', gpu: 'Mali-G68', batt: 5000, chg: 67, cam: [50, 8, 32], camf: 32, ramOpts: [8, 12], romOpts: [256, 512], price0: 94999, priceStep: 14000, os: 'Android 14, ColorOS', net: '5G', wt: 182, dim: '162.1×74.4×7.6mm', colors: ['Rock Grey', 'Coral Purple'] },
  { b: 'Oppo', m: 'A78', mn: 'CPH2565', y: 2023, cat: 'budget', dsize: 6.56, dtype: 'IPS LCD', refresh: 90, res: '2412x1080', chip: 'Snapdragon 680', gpu: 'Adreno 610', batt: 5000, chg: 33, cam: [50, 2], camf: 8, ramOpts: [8], romOpts: [128, 256], price0: 44999, priceStep: 6000, os: 'Android 13, ColorOS', net: '4G', wt: 187, dim: '163.8×74.7×7.9mm', colors: ['Glowing Black', 'Glowing Blue'] },
  { b: 'Oppo', m: 'A98', mn: 'CPH2545', y: 2023, cat: 'midrange', dsize: 6.72, dtype: 'AMOLED', refresh: 90, res: '2400x1080', chip: 'Snapdragon 695', gpu: 'Adreno 619', batt: 5000, chg: 67, cam: [64, 2], camf: 32, ramOpts: [8, 12], romOpts: [256], price0: 59999, priceStep: 0, os: 'Android 13, ColorOS', net: '5G', wt: 187, dim: '163.8×74.6×7.6mm', colors: ['Aqua Green', 'Dusk Purple'] },
  { b: 'Oppo', m: 'Find X6 Pro', mn: 'PGT110', y: 2023, cat: 'flagship', dsize: 6.82, dtype: 'LTPO AMOLED', refresh: 120, res: '2780x1264', chip: 'Snapdragon 8 Gen 2', gpu: 'Adreno 740', batt: 5000, chg: 100, cam: [50, 50, 50], camf: 32, ramOpts: [12, 16], romOpts: [256, 512], price0: 279999, priceStep: 30000, os: 'Android 13, ColorOS', net: '5G', wt: 221, dim: '164.5×76.2×9.5mm', colors: ['Desert Silver', 'Cornfield Green'] },
  { b: 'Oppo', m: 'F25 Pro', mn: 'CPH2555', y: 2024, cat: 'midrange', dsize: 6.7, dtype: 'AMOLED', refresh: 120, res: '2412x1080', chip: 'Dimensity 7050', gpu: 'Mali-G68', batt: 5000, chg: 67, cam: [64, 2], camf: 32, ramOpts: [8, 12], romOpts: [256], price0: 74999, priceStep: 0, os: 'Android 14, ColorOS', net: '5G', wt: 187, dim: '162.2×74.9×7.6mm', colors: ['Coral Pink', 'Wave Blue'] },
  // Vivo
  { b: 'Vivo', m: 'V29', mn: 'V2245', y: 2023, cat: 'midrange', dsize: 6.78, dtype: 'AMOLED', refresh: 120, res: '2800x1260', chip: 'Dimensity 8200', gpu: 'Mali-G610', batt: 4600, chg: 80, cam: [50, 8, 2], camf: 50, ramOpts: [8, 12], romOpts: [256], price0: 84999, priceStep: 0, os: 'Android 13, FunTouch OS', net: '5G', wt: 186, dim: '163.4×74.2×7.4mm', colors: ['Starry Purple', 'Space Black'] },
  { b: 'Vivo', m: 'V30', mn: 'V2318', y: 2024, cat: 'midrange', dsize: 6.78, dtype: 'AMOLED', refresh: 120, res: '2800x1260', chip: 'Snapdragon 7 Gen 3', gpu: 'Adreno 720', batt: 5000, chg: 80, cam: [50, 50], camf: 50, ramOpts: [8, 12], romOpts: [256, 512], price0: 99999, priceStep: 14000, os: 'Android 14, FunTouch OS', net: '5G', wt: 187, dim: '163.2×74.3×7.6mm', colors: ['Peacock Green', 'Titanium Silver'] },
  { b: 'Vivo', m: 'Y17s', mn: 'V2308', y: 2023, cat: 'budget', dsize: 6.56, dtype: 'IPS LCD', refresh: 60, res: '1612x720', chip: 'MediaTek Helio G85', gpu: 'Mali-G52', batt: 5000, chg: 15, cam: [13, 0.08], camf: 8, ramOpts: [4, 8], romOpts: [128, 128], price0: 27999, priceStep: 0, os: 'Android 13, FunTouch OS', net: '4G', wt: 186, dim: '164.2×75.7×7.9mm', colors: ['Glitter Black', 'Golden'] },
  { b: 'Vivo', m: 'Y36', mn: 'V2246', y: 2023, cat: 'budget', dsize: 6.64, dtype: 'IPS LCD', refresh: 90, res: '2388x1080', chip: 'Snapdragon 680', gpu: 'Adreno 610', batt: 5000, chg: 44, cam: [50, 2], camf: 8, ramOpts: [8], romOpts: [128, 256], price0: 42999, priceStep: 6000, os: 'Android 13, FunTouch OS', net: '4G', wt: 187, dim: '164.6×75.3×7.9mm', colors: ['Vitality Blue', 'Elegant Black'] },
  { b: 'Vivo', m: 'X100', mn: 'V2266A', y: 2023, cat: 'flagship', dsize: 6.78, dtype: 'LTPO AMOLED', refresh: 120, res: '2800x1260', chip: 'Dimensity 9300', gpu: 'Mali-G720', batt: 5000, chg: 120, cam: [50, 50, 50], camf: 32, ramOpts: [12, 16], romOpts: [256, 512], price0: 259999, priceStep: 28000, os: 'Android 14, FunTouch OS', net: '5G', wt: 206, dim: '164.0×74.8×8.5mm', colors: ['Asteroid Black', 'Song Mountain Blue'] },
  { b: 'Vivo', m: 'T3', mn: 'V2318A', y: 2024, cat: 'gaming', dsize: 6.67, dtype: 'AMOLED', refresh: 120, res: '2400x1080', chip: 'Dimensity 7300', gpu: 'Mali-G615', batt: 5000, chg: 80, cam: [50, 2], camf: 16, ramOpts: [8, 12], romOpts: [128, 256], price0: 54999, priceStep: 9000, os: 'Android 14, FunTouch OS', net: '5G', wt: 186, dim: '163.0×75.1×7.7mm', colors: ['Racing Black', 'Panda White'] },
  // Realme
  { b: 'Realme', m: 'C55', mn: 'RMX3710', y: 2023, cat: 'budget', dsize: 6.72, dtype: 'IPS LCD', refresh: 90, res: '2400x1080', chip: 'MediaTek Helio G88', gpu: 'Mali-G52', batt: 5000, chg: 33, cam: [64, 2], camf: 8, ramOpts: [6, 8], romOpts: [128, 256], price0: 34999, priceStep: 6000, os: 'Android 13, Realme UI', net: '4G', wt: 190, dim: '164.4×74.6×7.9mm', colors: ['Sunshower', 'Rainy Night'] },
  { b: 'Realme', m: '11 Pro', mn: 'RMX3771', y: 2023, cat: 'midrange', dsize: 6.7, dtype: 'AMOLED', refresh: 120, res: '2412x1080', chip: 'Dimensity 7050', gpu: 'Mali-G68', batt: 5000, chg: 67, cam: [100, 2], camf: 16, ramOpts: [8, 12], romOpts: [256], price0: 62999, priceStep: 0, os: 'Android 13, Realme UI', net: '5G', wt: 190, dim: '162.8×74.3×7.9mm', colors: ['Sunrise Beige', 'Astral Black'] },
  { b: 'Realme', m: '12 Pro+', mn: 'RMX3840', y: 2024, cat: 'midrange', dsize: 6.7, dtype: 'AMOLED', refresh: 120, res: '2412x1080', chip: 'Snapdragon 6 Gen 1', gpu: 'Adreno 610', batt: 5000, chg: 67, cam: [50, 64, 8], camf: 16, ramOpts: [8, 12], romOpts: [256, 512], price0: 79999, priceStep: 12000, os: 'Android 14, Realme UI', net: '5G', wt: 190, dim: '162.7×74.2×8.6mm', colors: ['Submarine Blue', 'Beige'] },
  { b: 'Realme', m: 'GT5', mn: 'RMX3708', y: 2023, cat: 'gaming', dsize: 6.74, dtype: 'AMOLED', refresh: 144, res: '2780x1264', chip: 'Snapdragon 8+ Gen 1', gpu: 'Adreno 730', batt: 4600, chg: 240, cam: [50, 8, 2], camf: 16, ramOpts: [12, 16], romOpts: [256, 512], price0: 124999, priceStep: 18000, os: 'Android 13, Realme UI', net: '5G', wt: 199, dim: '163.1×75.0×8.7mm', colors: ['Racing Yellow', 'Fluid Black'] },
  { b: 'Realme', m: 'Narzo 60', mn: 'RMX3760', y: 2023, cat: 'midrange', dsize: 6.72, dtype: 'AMOLED', refresh: 120, res: '2412x1080', chip: 'Dimensity 6100+', gpu: 'Mali-G57', batt: 5000, chg: 67, cam: [64, 2], camf: 16, ramOpts: [8], romOpts: [128, 256], price0: 47999, priceStep: 7000, os: 'Android 13, Realme UI', net: '5G', wt: 187, dim: '164.4×74.7×7.8mm', colors: ['Cosmic Purple', 'Mars Orange'] },
  { b: 'Realme', m: '10 Pro', mn: 'RMX3661', y: 2022, cat: 'midrange', dsize: 6.72, dtype: 'AMOLED', refresh: 120, res: '2412x1080', chip: 'Snapdragon 695', gpu: 'Adreno 619', batt: 5000, chg: 33, cam: [108, 2], camf: 16, ramOpts: [6, 8], romOpts: [128, 256], price0: 49999, priceStep: 8000, os: 'Android 12, Realme UI', net: '5G', wt: 190, dim: '163.25×75.23×7.87mm', colors: ['Hyperspace', 'Nebula Blue'] },
  // Honor
  { b: 'Honor', m: '90', mn: 'REA-NX9', y: 2023, cat: 'midrange', dsize: 6.7, dtype: 'AMOLED', refresh: 120, res: '2664x1200', chip: 'Snapdragon 7 Gen 1', gpu: 'Adreno 662', batt: 5000, chg: 66, cam: [200, 12], camf: 50, ramOpts: [8, 12], romOpts: [256, 512], price0: 79999, priceStep: 12000, os: 'Android 13, MagicOS', net: '5G', wt: 183, dim: '161.9×74.1×7.6mm', colors: ['Emerald Green', 'Midnight Black'] },
  { b: 'Honor', m: 'X9b', mn: 'ALI-NX1', y: 2024, cat: 'midrange', dsize: 6.78, dtype: 'AMOLED', refresh: 120, res: '2652x1200', chip: 'Snapdragon 6 Gen 1', gpu: 'Adreno 610', batt: 5800, chg: 66, cam: [108, 2], camf: 16, ramOpts: [8, 12], romOpts: [256], price0: 54999, priceStep: 0, os: 'Android 14, MagicOS', net: '5G', wt: 196, dim: '163.3×74.2×7.98mm', colors: ['Titanium Silver', 'Emerald Green'] },
  { b: 'Honor', m: 'Magic6 Pro', mn: 'BVL-N49', y: 2024, cat: 'flagship', dsize: 6.8, dtype: 'LTPO OLED', refresh: 120, res: '2800x1280', chip: 'Snapdragon 8 Gen 3', gpu: 'Adreno 750', batt: 5600, chg: 80, cam: [50, 12, 12], camf: 50, ramOpts: [12, 16], romOpts: [512], price0: 289999, priceStep: 0, os: 'Android 14, MagicOS', net: '5G', wt: 225, dim: '162.5×75.8×8.9mm', colors: ['Black', 'Green'] },
  { b: 'Honor', m: 'X7b', mn: 'CRT-NX1', y: 2024, cat: 'budget', dsize: 6.74, dtype: 'IPS LCD', refresh: 90, res: '2388x1080', chip: 'Snapdragon 685', gpu: 'Adreno 610', batt: 5800, chg: 35, cam: [108, 2], camf: 8, ramOpts: [8], romOpts: [256], price0: 39999, priceStep: 0, os: 'Android 13, MagicOS', net: '4G', wt: 196, dim: '165.6×76.1×8.05mm', colors: ['Midnight Black', 'Ocean Blue'] },
  { b: 'Honor', m: '200 Pro', mn: 'ALI-N39', y: 2024, cat: 'flagship', dsize: 6.78, dtype: 'AMOLED', refresh: 120, res: '2700x1224', chip: 'Snapdragon 8 Gen 2', gpu: 'Adreno 730', batt: 5200, chg: 100, cam: [50, 50, 50], camf: 50, ramOpts: [12], romOpts: [256, 512], price0: 149999, priceStep: 20000, os: 'Android 14, MagicOS', net: '5G', wt: 182, dim: '162.6×75.2×8.9mm', colors: ['Moonlight White', 'Black'] },
  // Huawei
  { b: 'Huawei', m: 'P60 Pro', mn: 'LNA-AL00', y: 2023, cat: 'flagship', dsize: 6.67, dtype: 'LTPO OLED', refresh: 120, res: '2700x1220', chip: 'Snapdragon 8+ Gen 1 (4G)', gpu: 'Adreno 730', batt: 4815, chg: 88, cam: [48, 13, 48], camf: 13, ramOpts: [8, 12], romOpts: [256, 512], price0: 269999, priceStep: 28000, os: 'HarmonyOS 4', net: '4G', wt: 200, dim: '161.1×74.5×8.29mm', colors: ['Rococo Pearl', 'Black'] },
  { b: 'Huawei', m: 'Nova 11', mn: 'ALT-AL00', y: 2023, cat: 'midrange', dsize: 6.7, dtype: 'OLED', refresh: 120, res: '2412x1080', chip: 'Snapdragon 778G', gpu: 'Adreno 642L', batt: 4500, chg: 66, cam: [50, 2], camf: 60, ramOpts: [8], romOpts: [256, 512], price0: 89999, priceStep: 15000, os: 'HarmonyOS 3.1', net: '4G', wt: 180, dim: '161.1×73.8×7.35mm', colors: ['Green', 'Black'] },
  { b: 'Huawei', m: 'Mate 60 Pro', mn: 'ALN-AL00', y: 2023, cat: 'flagship', dsize: 6.82, dtype: 'LTPO OLED', refresh: 120, res: '2720x1260', chip: 'Kirin 9000S', gpu: 'Maleoon 910', batt: 5000, chg: 88, cam: [50, 12, 48], camf: 13, ramOpts: [12], romOpts: [256, 512, 1024], price0: 349999, priceStep: 40000, os: 'HarmonyOS 4', net: '5G', wt: 225, dim: '163.7×79.0×8.9mm', colors: ['Black', 'White', 'Purple'] },
  { b: 'Huawei', m: 'Y9a', mn: 'ADA-AL00', y: 2021, cat: 'budget', dsize: 6.63, dtype: 'IPS LCD', refresh: 60, res: '2400x1080', chip: 'Kirin 710A', gpu: 'Mali-G51', batt: 5000, chg: 40, cam: [64, 8, 2], camf: 16, ramOpts: [6, 8], romOpts: [128, 128], price0: 34999, priceStep: 5000, os: 'EMUI 11', net: '4G', wt: 196, dim: '163.5×77.3×8.85mm', colors: ['Midnight Black', 'Emerald Green'] },
  { b: 'Huawei', m: 'Nova Y91', mn: 'MOA-LX9N', y: 2023, cat: 'budget', dsize: 6.95, dtype: 'IPS LCD', refresh: 90, res: '2388x1080', chip: 'Snapdragon 680', gpu: 'Adreno 610', batt: 5000, chg: 22.5, cam: [48, 2], camf: 8, ramOpts: [8], romOpts: [128], price0: 29999, priceStep: 0, os: 'EMUI 13', net: '4G', wt: 198, dim: '168.8×76.9×8.5mm', colors: ['Starry Black', 'Emerald Green'] },
  // Motorola
  { b: 'Motorola', m: 'Edge 40', mn: 'XT2309-3', y: 2023, cat: 'midrange', dsize: 6.55, dtype: 'P-OLED', refresh: 144, res: '2400x1080', chip: 'Dimensity 8020', gpu: 'Mali-G77', batt: 4400, chg: 68, cam: [50, 13], camf: 32, ramOpts: [8], romOpts: [256], price0: 89999, priceStep: 0, os: 'Android 13', net: '5G', wt: 167, dim: '158.4×71.9×7.6mm', colors: ['Eclipse Black', 'Nebula Green'] },
  { b: 'Motorola', m: 'Edge 50 Pro', mn: 'XT2403-1', y: 2024, cat: 'flagship', dsize: 6.7, dtype: 'P-OLED', refresh: 144, res: '2712x1220', chip: 'Snapdragon 7 Gen 3', gpu: 'Adreno 720', batt: 4500, chg: 125, cam: [50, 13, 10], camf: 32, ramOpts: [8, 12], romOpts: [256, 512], price0: 119999, priceStep: 16000, os: 'Android 14', net: '5G', wt: 186, dim: '160.9×72.0×8.2mm', colors: ['Black Beauty', 'Luxe Lavender'] },
  { b: 'Motorola', m: 'Moto G84', mn: 'XT2347-1', y: 2023, cat: 'midrange', dsize: 6.55, dtype: 'P-OLED', refresh: 120, res: '2400x1080', chip: 'Snapdragon 695', gpu: 'Adreno 619', batt: 5000, chg: 33, cam: [50, 8], camf: 16, ramOpts: [8, 12], romOpts: [128, 256], price0: 54999, priceStep: 8000, os: 'Android 13', net: '5G', wt: 166, dim: '160.4×73.8×7.6mm', colors: ['Midnight Blue', 'Viva Magenta'] },
  { b: 'Motorola', m: 'Moto G54', mn: 'XT2343-1', y: 2023, cat: 'budget', dsize: 6.5, dtype: 'IPS LCD', refresh: 120, res: '2400x1080', chip: 'Dimensity 7020', gpu: 'Mali-G57', batt: 6000, chg: 33, cam: [50, 8], camf: 16, ramOpts: [8, 12], romOpts: [128, 256], price0: 39999, priceStep: 6000, os: 'Android 13', net: '5G', wt: 191, dim: '161.2×74.1×7.79mm', colors: ['Midnight Blue', 'Pearl Blue'] },
  { b: 'Motorola', m: 'Razr 40', mn: 'XT2323-1', y: 2023, cat: 'foldable', dsize: 6.9, dtype: 'Foldable P-OLED', refresh: 144, res: '2640x1080', chip: 'Snapdragon 7 Gen 1', gpu: 'Adreno 664', batt: 4200, chg: 30, cam: [64], camf: 32, ramOpts: [8], romOpts: [256], price0: 199999, priceStep: 0, os: 'Android 13', net: '5G', wt: 188, dim: '170.83×73.95×6.99mm (unfolded)', colors: ['Sage Green', 'Vanilla Cream'] },
  // Nokia
  { b: 'Nokia', m: 'G42', mn: 'TA-1528', y: 2023, cat: 'budget', dsize: 6.56, dtype: 'IPS LCD', refresh: 90, res: '1612x720', chip: 'Snapdragon 480+', gpu: 'Adreno 619', batt: 5000, chg: 20, cam: [50, 2], camf: 8, ramOpts: [4, 6], romOpts: [128, 128], price0: 32999, priceStep: 3000, os: 'Android 13', net: '5G', wt: 190, dim: '163.9×75.5×8.4mm', colors: ['So Purple', 'So Grey'] },
  { b: 'Nokia', m: 'X30', mn: 'TA-1450', y: 2022, cat: 'midrange', dsize: 6.43, dtype: 'OLED', refresh: 90, res: '2400x1080', chip: 'Snapdragon 695', gpu: 'Adreno 619', batt: 4200, chg: 33, cam: [50, 13], camf: 16, ramOpts: [8], romOpts: [256], price0: 64999, priceStep: 0, os: 'Android 13', net: '5G', wt: 185, dim: '160.4×74.7×8.3mm', colors: ['Ice', 'Forest'] },
  { b: 'Nokia', m: 'C32', mn: 'TA-1546', y: 2023, cat: 'budget', dsize: 6.5, dtype: 'IPS LCD', refresh: 90, res: '1600x720', chip: 'Unisoc T606', gpu: 'Mali-G57', batt: 5000, chg: 10, cam: [50, 2], camf: 8, ramOpts: [4], romOpts: [64, 128], price0: 21999, priceStep: 3000, os: 'Android 13', net: '4G', wt: 192, dim: '164.9×75.9×8.4mm', colors: ['Charcoal', 'Beach Pink'] },
  { b: 'Nokia', m: '5.4', mn: 'TA-1332', y: 2021, cat: 'budget', dsize: 6.39, dtype: 'IPS LCD', refresh: 60, res: '1560x720', chip: 'Snapdragon 662', gpu: 'Adreno 610', batt: 4000, chg: 10, cam: [48, 5, 2], camf: 16, ramOpts: [4, 6], romOpts: [64, 128], price0: 27999, priceStep: 4000, os: 'Android 11', net: '4G', wt: 181, dim: '160.0×75.9×8.7mm', colors: ['Polar Night', 'Dusk'] },
  // Sony
  { b: 'Sony', m: 'Xperia 1 VI', mn: 'XQ-EC72', y: 2024, cat: 'flagship', dsize: 6.5, dtype: 'LTPO OLED', refresh: 120, res: '2340x1080', chip: 'Snapdragon 8 Gen 3', gpu: 'Adreno 750', batt: 5000, chg: 30, cam: [48, 48, 12], camf: 12, ramOpts: [12], romOpts: [256, 512], price0: 329999, priceStep: 40000, os: 'Android 14', net: '5G', wt: 193, dim: '161.0×74.0×8.2mm', colors: ['Black', 'Platinum Silver', 'Khaki Green'] },
  { b: 'Sony', m: 'Xperia 10 VI', mn: 'XQ-EC44', y: 2024, cat: 'midrange', dsize: 6.1, dtype: 'OLED', refresh: 60, res: '2520x1080', chip: 'Snapdragon 6 Gen 1', gpu: 'Adreno 610', batt: 5000, chg: 30, cam: [48, 8], camf: 12, ramOpts: [8], romOpts: [128], price0: 94999, priceStep: 0, os: 'Android 14', net: '5G', wt: 164, dim: '155.0×68.0×8.3mm', colors: ['Black', 'White', 'Lavender'] },
  { b: 'Sony', m: 'Xperia 5 V', mn: 'XQ-DE72', y: 2023, cat: 'flagship', dsize: 6.1, dtype: 'OLED', refresh: 120, res: '2520x1080', chip: 'Snapdragon 8 Gen 2', gpu: 'Adreno 740', batt: 5000, chg: 30, cam: [48, 12], camf: 12, ramOpts: [8], romOpts: [128, 256], price0: 259999, priceStep: 30000, os: 'Android 13', net: '5G', wt: 182, dim: '156.0×67.0×8.6mm', colors: ['Black', 'Blue', 'Ecru'] },
  // Asus
  { b: 'Asus', m: 'ROG Phone 8 Pro', mn: 'AI2401', y: 2024, cat: 'gaming', dsize: 6.78, dtype: 'LTPO AMOLED', refresh: 165, res: '2400x1080', chip: 'Snapdragon 8 Gen 3', gpu: 'Adreno 750', batt: 5500, chg: 65, cam: [50, 13, 32], camf: 32, ramOpts: [16, 24], romOpts: [512, 1024], price0: 349999, priceStep: 40000, os: 'Android 14', net: '5G', wt: 225, dim: '163.8×76.8×8.9mm', colors: ['Phantom Black'] },
  { b: 'Asus', m: 'ROG Phone 8', mn: 'AI2401-B', y: 2024, cat: 'gaming', dsize: 6.78, dtype: 'AMOLED', refresh: 165, res: '2400x1080', chip: 'Snapdragon 8 Gen 3', gpu: 'Adreno 750', batt: 5500, chg: 65, cam: [50, 13], camf: 32, ramOpts: [12, 16], romOpts: [256, 512], price0: 279999, priceStep: 30000, os: 'Android 14', net: '5G', wt: 225, dim: '163.8×76.8×8.9mm', colors: ['Phantom Black', 'Rebel Gray'] },
  { b: 'Asus', m: 'Zenfone 11 Ultra', mn: 'AI2401-C', y: 2024, cat: 'flagship', dsize: 6.78, dtype: 'LTPO AMOLED', refresh: 165, res: '2400x1080', chip: 'Snapdragon 8 Gen 3', gpu: 'Adreno 750', batt: 5500, chg: 65, cam: [50, 13, 32], camf: 32, ramOpts: [12, 16], romOpts: [256, 512], price0: 239999, priceStep: 25000, os: 'Android 14', net: '5G', wt: 224, dim: '163.8×76.8×9.19mm', colors: ['Skyline Blue', 'Basalt Gray'] },
  // Nothing
  { b: 'Nothing', m: 'Phone 1', mn: 'A063', y: 2022, cat: 'midrange', dsize: 6.55, dtype: 'AMOLED', refresh: 120, res: '2400x1080', chip: 'Snapdragon 778G+', gpu: 'Adreno 642L', batt: 4500, chg: 33, cam: [50, 50], camf: 16, ramOpts: [8, 12], romOpts: [128, 256], price0: 79999, priceStep: 12000, os: 'Nothing OS (Android 13)', net: '5G', wt: 193.5, dim: '159.2×75.8×8.3mm', colors: ['Black', 'White'] },
  { b: 'Nothing', m: 'Phone 2', mn: 'A065', y: 2023, cat: 'flagship', dsize: 6.7, dtype: 'OLED', refresh: 120, res: '2412x1080', chip: 'Snapdragon 8+ Gen 1', gpu: 'Adreno 730', batt: 4700, chg: 45, cam: [50, 50], camf: 32, ramOpts: [8, 12], romOpts: [256, 512], price0: 129999, priceStep: 18000, os: 'Nothing OS (Android 14)', net: '5G', wt: 201, dim: '162.1×76.4×8.6mm', colors: ['White', 'Dark Grey'] },
  { b: 'Nothing', m: 'Phone 2a', mn: 'A142', y: 2024, cat: 'midrange', dsize: 6.7, dtype: 'AMOLED', refresh: 120, res: '2412x1080', chip: 'Dimensity 7200 Pro', gpu: 'Mali-G610', batt: 5000, chg: 45, cam: [50, 50], camf: 32, ramOpts: [8, 12], romOpts: [128, 256], price0: 64999, priceStep: 10000, os: 'Nothing OS (Android 14)', net: '5G', wt: 190, dim: '161.7×76.3×8.55mm', colors: ['Black', 'Milk'] },
  // ZTE
  { b: 'ZTE', m: 'Nubia Z60 Ultra', mn: 'NX751J', y: 2024, cat: 'flagship', dsize: 6.85, dtype: 'AMOLED', refresh: 120, res: '3168x1440', chip: 'Snapdragon 8 Gen 3', gpu: 'Adreno 750', batt: 6000, chg: 80, cam: [50, 50, 50], camf: 16, ramOpts: [12, 16], romOpts: [256, 512, 1024], price0: 219999, priceStep: 25000, os: 'Android 14, MyOS', net: '5G', wt: 229, dim: '163.5×76.0×8.5mm', colors: ['Black', 'Silver'] },
  { b: 'ZTE', m: 'Blade A54', mn: 'A5040', y: 2022, cat: 'budget', dsize: 6.6, dtype: 'IPS LCD', refresh: 90, res: '1612x720', chip: 'Unisoc T606', gpu: 'Mali-G57', batt: 5000, chg: 18, cam: [13, 2], camf: 8, ramOpts: [4], romOpts: [128], price0: 24999, priceStep: 0, os: 'Android 12', net: '4G', wt: 190, dim: '165.4×75.9×8.5mm', colors: ['Black', 'Blue'] },
  { b: 'ZTE', m: 'Nubia Red Magic 9 Pro', mn: 'NX769J', y: 2024, cat: 'gaming', dsize: 6.85, dtype: 'AMOLED', refresh: 120, res: '2480x1116', chip: 'Snapdragon 8 Gen 3', gpu: 'Adreno 750', batt: 6000, chg: 80, cam: [50, 50], camf: 16, ramOpts: [12, 16, 24], romOpts: [256, 512, 1024], price0: 199999, priceStep: 25000, os: 'Android 14, RedMagic OS', net: '5G', wt: 229, dim: '163.98×76.35×8.9mm', colors: ['Obsidian', 'Cyber Neon'] },
  { b: 'ZTE', m: 'Blade V50', mn: 'V5040', y: 2023, cat: 'budget', dsize: 6.7, dtype: 'IPS LCD', refresh: 90, res: '2408x1080', chip: 'Snapdragon 4 Gen 2', gpu: 'Adreno 613', batt: 5000, chg: 33, cam: [50, 2], camf: 8, ramOpts: [8], romOpts: [256], price0: 34999, priceStep: 0, os: 'Android 13', net: '5G', wt: 198, dim: '165.5×75.9×7.9mm', colors: ['Black', 'Green'] },
  { b: 'ZTE', m: 'Axon 50', mn: 'A2352', y: 2023, cat: 'midrange', dsize: 6.72, dtype: 'AMOLED', refresh: 120, res: '2400x1080', chip: 'Dimensity 8020', gpu: 'Mali-G77', batt: 5160, chg: 66, cam: [64, 8, 2], camf: 16, ramOpts: [8, 12], romOpts: [256], price0: 59999, priceStep: 0, os: 'Android 13', net: '5G', wt: 190, dim: '163.5×75.0×8.4mm', colors: ['Black', 'Blue'] },
  // Infinix
  { b: 'Infinix', m: 'Note 40 Pro', mn: 'X6857', y: 2024, cat: 'midrange', dsize: 6.78, dtype: 'AMOLED', refresh: 120, res: '2400x1080', chip: 'Dimensity 7020', gpu: 'Mali-G57', batt: 5000, chg: 70, cam: [108, 2], camf: 32, ramOpts: [8, 12], romOpts: [256], price0: 54999, priceStep: 0, os: 'Android 14, XOS', net: '4G', wt: 190, dim: '164.2×75.6×7.9mm', colors: ['Titan Gold', 'Vintage Green'] },
  { b: 'Infinix', m: 'Zero 30', mn: 'X6731', y: 2023, cat: 'midrange', dsize: 6.78, dtype: 'AMOLED', refresh: 144, res: '2436x1096', chip: 'Dimensity 8020', gpu: 'Mali-G77', batt: 5000, chg: 68, cam: [108, 13, 2], camf: 50, ramOpts: [8, 12], romOpts: [256], price0: 49999, priceStep: 0, os: 'Android 13, XOS', net: '4G', wt: 193, dim: '163.6×74.9×7.99mm', colors: ['Nebula Black', 'Coral Green'] },
  { b: 'Infinix', m: 'Hot 40', mn: 'X6837', y: 2024, cat: 'budget', dsize: 6.78, dtype: 'AMOLED', refresh: 120, res: '2460x1080', chip: 'MediaTek Helio G91', gpu: 'Mali-G52', batt: 5000, chg: 33, cam: [108, 2], camf: 8, ramOpts: [8], romOpts: [128, 256], price0: 29999, priceStep: 5000, os: 'Android 14, XOS', net: '4G', wt: 187, dim: '164.5×75.5×7.7mm', colors: ['Palm Blue', 'Gravity Black'] },
  { b: 'Infinix', m: 'GT 20 Pro', mn: 'X6739', y: 2024, cat: 'gaming', dsize: 6.78, dtype: 'AMOLED', refresh: 144, res: '2436x1096', chip: 'Dimensity 8200', gpu: 'Mali-G610', batt: 5000, chg: 45, cam: [108, 13], camf: 32, ramOpts: [12], romOpts: [256], price0: 64999, priceStep: 0, os: 'Android 14, XOS', net: '5G', wt: 202, dim: '164.3×75.5×8.3mm', colors: ['Racing Black', 'Cyber Silver'] },
  { b: 'Infinix', m: 'Smart 8', mn: 'X6525', y: 2023, cat: 'budget', dsize: 6.6, dtype: 'IPS LCD', refresh: 90, res: '1612x720', chip: 'Unisoc SC9863A', gpu: 'PowerVR GE8322', batt: 5000, chg: 10, cam: [13, 0.08], camf: 8, ramOpts: [3, 4], romOpts: [64, 64], price0: 16999, priceStep: 2000, os: 'Android 13, XOS', net: '4G', wt: 188, dim: '164.9×76.2×8.4mm', colors: ['Galaxy White', 'Timber Black'] },
  // Tecno
  { b: 'Tecno', m: 'Camon 20', mn: 'CK6n', y: 2023, cat: 'midrange', dsize: 6.67, dtype: 'AMOLED', refresh: 90, res: '2400x1080', chip: 'MediaTek Helio G99', gpu: 'Mali-G57', batt: 5000, chg: 33, cam: [64, 2], camf: 32, ramOpts: [8], romOpts: [128, 256], price0: 44999, priceStep: 7000, os: 'Android 13, HiOS', net: '4G', wt: 187, dim: '163.9×74.9×7.8mm', colors: ['Serenity Blue', 'Predawn Black'] },
  { b: 'Tecno', m: 'Spark 20', mn: 'KJ5n', y: 2024, cat: 'budget', dsize: 6.6, dtype: 'IPS LCD', refresh: 90, res: '1612x720', chip: 'MediaTek Helio G85', gpu: 'Mali-G52', batt: 5000, chg: 18, cam: [50, 0.08], camf: 8, ramOpts: [4, 8], romOpts: [128, 128], price0: 24999, priceStep: 4000, os: 'Android 14, HiOS', net: '4G', wt: 186, dim: '164.8×75.6×7.8mm', colors: ['Gravity Black', 'Magic Skin Green'] },
  { b: 'Tecno', m: 'Phantom V Fold', mn: 'AD10', y: 2023, cat: 'foldable', dsize: 7.85, dtype: 'Foldable AMOLED', refresh: 120, res: '1920x2544', chip: 'Dimensity 9000+', gpu: 'Mali-G710', batt: 5860, chg: 45, cam: [50, 13, 2], camf: 32, ramOpts: [12], romOpts: [256, 512], price0: 249999, priceStep: 30000, os: 'Android 13, HiOS', net: '5G', wt: 299, dim: '155.7×132.5×7.7mm (unfolded)', colors: ['Space Gray', 'Mystery White'] },
  { b: 'Tecno', m: 'Pova 6', mn: 'LH7n', y: 2024, cat: 'gaming', dsize: 6.78, dtype: 'AMOLED', refresh: 120, res: '2436x1080', chip: 'Dimensity 6080', gpu: 'Mali-G57', batt: 6000, chg: 70, cam: [108, 2], camf: 32, ramOpts: [8, 12], romOpts: [256], price0: 39999, priceStep: 0, os: 'Android 14, HiOS', net: '5G', wt: 196, dim: '164.5×75.5×7.9mm', colors: ['Racing Green', 'Cyber Black'] },
  { b: 'Tecno', m: 'Pop 8', mn: 'BG6n', y: 2023, cat: 'budget', dsize: 6.56, dtype: 'IPS LCD', refresh: 90, res: '1612x720', chip: 'Unisoc T606', gpu: 'Mali-G57', batt: 5000, chg: 10, cam: [13, 0.08], camf: 8, ramOpts: [3, 4], romOpts: [64, 128], price0: 17999, priceStep: 3000, os: 'Android 13 Go', net: '4G', wt: 185, dim: '164.2×75.6×8.4mm', colors: ['Ivy Green', 'Gravity Black'] },
  // itel
  { b: 'itel', m: 'A70', mn: 'S665LN', y: 2023, cat: 'budget', dsize: 6.6, dtype: 'IPS LCD', refresh: 90, res: '1612x720', chip: 'Unisoc T603', gpu: 'IMG8300', batt: 5000, chg: 10, cam: [13, 0.08], camf: 5, ramOpts: [3, 4], romOpts: [64, 64], price0: 15999, priceStep: 2000, os: 'Android 13 Go', net: '4G', wt: 188, dim: '164.9×76.2×8.5mm', colors: ['Glass Blue', 'Nebula Black'] },
  { b: 'itel', m: 'S23+', mn: 'S667LN', y: 2023, cat: 'budget', dsize: 6.6, dtype: 'AMOLED', refresh: 90, res: '2408x1080', chip: 'Unisoc T616', gpu: 'Mali-G57', batt: 5000, chg: 18, cam: [50, 2], camf: 16, ramOpts: [8], romOpts: [128, 256], price0: 22999, priceStep: 3000, os: 'Android 13', net: '4G', wt: 188, dim: '164.9×75.5×7.8mm', colors: ['Mint Green', 'Nebula Black'] },
  { b: 'itel', m: 'P55', mn: 'S661LN', y: 2023, cat: 'budget', dsize: 6.6, dtype: 'IPS LCD', refresh: 90, res: '1612x720', chip: 'Unisoc T612', gpu: 'Mali-G57', batt: 6000, chg: 18, cam: [50, 0.08], camf: 8, ramOpts: [4, 8], romOpts: [128, 128], price0: 24999, priceStep: 4000, os: 'Android 13', net: '4G', wt: 198, dim: '166.0×76.5×9.3mm', colors: ['Racing Black', 'Aurora Green'] },
  // Lenovo
  { b: 'Lenovo', m: 'Legion Y70', mn: 'L71121', y: 2022, cat: 'gaming', dsize: 6.67, dtype: 'AMOLED', refresh: 144, res: '2400x1080', chip: 'Snapdragon 8+ Gen 1', gpu: 'Adreno 730', batt: 5100, chg: 68, cam: [64, 13], camf: 16, ramOpts: [8, 12, 16], romOpts: [128, 256, 512], price0: 119999, priceStep: 15000, os: 'Android 12, ZUI', net: '5G', wt: 209, dim: '163.2×75.0×8.75mm', colors: ['Storm Grey', 'Blade Silver'] },
  { b: 'Lenovo', m: 'K14 Plus', mn: 'L83131', y: 2023, cat: 'budget', dsize: 6.6, dtype: 'IPS LCD', refresh: 90, res: '1612x720', chip: 'MediaTek Helio G88', gpu: 'Mali-G52', batt: 5000, chg: 18, cam: [50, 2], camf: 8, ramOpts: [4, 6], romOpts: [64, 128], price0: 26999, priceStep: 4000, os: 'Android 13', net: '4G', wt: 202, dim: '164.6×75.9×9.0mm', colors: ['Frost Blue', 'Obsidian Black'] },
  // --- 2021 devices — rounding out the 5-year-back boundary of the default window ---
  { b: 'Xiaomi', m: 'Mi 11', mn: 'M2011K2C', y: 2021, cat: 'flagship', dsize: 6.81, dtype: 'AMOLED', refresh: 120, res: '3200x1440', chip: 'Snapdragon 888', gpu: 'Adreno 660', batt: 4600, chg: 55, cam: [108, 13, 5], camf: 20, ramOpts: [8, 12], romOpts: [128, 256], price0: 149999, priceStep: 20000, os: 'Android 12, MIUI 12', net: '5G', wt: 196, dim: '164.3×74.6×8.06mm', colors: ['Midnight Gray', 'Horizon Blue', 'Frost White'] },
  { b: 'OnePlus', m: 'OnePlus 9', mn: 'LE2113', y: 2021, cat: 'flagship', dsize: 6.55, dtype: 'AMOLED', refresh: 120, res: '2400x1080', chip: 'Snapdragon 888', gpu: 'Adreno 660', batt: 4500, chg: 65, cam: [48, 50, 2], camf: 16, ramOpts: [8, 12], romOpts: [128, 256], price0: 139999, priceStep: 18000, os: 'Android 11, OxygenOS', net: '5G', wt: 183, dim: '160.0×74.2×8.1mm', colors: ['Astral Black', 'Arctic Sky', 'Winter Mist'] },
  { b: 'Oppo', m: 'Reno6', mn: 'CPH2251', y: 2021, cat: 'midrange', dsize: 6.43, dtype: 'AMOLED', refresh: 90, res: '2400x1080', chip: 'Dimensity 900', gpu: 'Mali-G68', batt: 4300, chg: 65, cam: [64, 8, 2], camf: 32, ramOpts: [8, 12], romOpts: [128, 256], price0: 69999, priceStep: 10000, os: 'Android 11, ColorOS', net: '5G', wt: 177, dim: '160.0×73.2×7.6mm', colors: ['Aurora', 'Stellar Black'] },
  { b: 'Vivo', m: 'V21', mn: 'V2066', y: 2021, cat: 'midrange', dsize: 6.44, dtype: 'AMOLED', refresh: 90, res: '2400x1080', chip: 'Dimensity 800U', gpu: 'Mali-G57', batt: 4000, chg: 33, cam: [64, 8, 2], camf: 44, ramOpts: [8], romOpts: [128], price0: 59999, priceStep: 0, os: 'Android 11, FunTouch OS', net: '5G', wt: 176, dim: '159.2×73.4×7.29mm', colors: ['Sunset Dazzle', 'Dusk Blue'] },
  { b: 'Realme', m: '8 Pro', mn: 'RMX3081', y: 2021, cat: 'midrange', dsize: 6.4, dtype: 'AMOLED', refresh: 60, res: '2400x1080', chip: 'Snapdragon 720G', gpu: 'Adreno 618', batt: 4500, chg: 50, cam: [108, 8, 2], camf: 16, ramOpts: [6, 8], romOpts: [128, 128], price0: 44999, priceStep: 6000, os: 'Android 11, Realme UI', net: '4G', wt: 176, dim: '160.6×73.9×8.1mm', colors: ['Punk Black', 'Illuminating Yellow'] },
  { b: 'Honor', m: '50', mn: 'NTH-NX9', y: 2021, cat: 'midrange', dsize: 6.57, dtype: 'AMOLED', refresh: 120, res: '2340x1080', chip: 'Snapdragon 778G', gpu: 'Adreno 642L', batt: 4300, chg: 66, cam: [108, 8, 2], camf: 32, ramOpts: [8, 12], romOpts: [128, 256], price0: 74999, priceStep: 10000, os: 'Android 11, MagicUI', net: '5G', wt: 175, dim: '160.1×73.8×7.78mm', colors: ['Emerald Green', 'Midnight Black'] },
  { b: 'Motorola', m: 'Edge 20', mn: 'XT2143-2', y: 2021, cat: 'midrange', dsize: 6.7, dtype: 'P-OLED', refresh: 144, res: '2400x1080', chip: 'Snapdragon 778G', gpu: 'Adreno 642L', batt: 4000, chg: 30, cam: [108, 8, 2], camf: 32, ramOpts: [6, 8], romOpts: [128, 256], price0: 64999, priceStep: 8000, os: 'Android 11', net: '5G', wt: 163, dim: '163.0×75.9×6.99mm', colors: ['Frosted Grey', 'Frosted White'] },
  { b: 'Sony', m: 'Xperia 5 III', mn: 'XQ-BQ72', y: 2021, cat: 'flagship', dsize: 6.1, dtype: 'OLED', refresh: 120, res: '2520x1080', chip: 'Snapdragon 888', gpu: 'Adreno 660', batt: 4500, chg: 30, cam: [12, 12, 12], camf: 8, ramOpts: [8], romOpts: [128, 256], price0: 219999, priceStep: 25000, os: 'Android 11', net: '5G', wt: 168, dim: '157.0×68.0×8.2mm', colors: ['Black', 'Green', 'Pink'] },
  { b: 'Asus', m: 'ROG Phone 5', mn: 'ZS673KS', y: 2021, cat: 'gaming', dsize: 6.78, dtype: 'AMOLED', refresh: 144, res: '2448x1080', chip: 'Snapdragon 888', gpu: 'Adreno 660', batt: 6000, chg: 65, cam: [64, 13, 5], camf: 24, ramOpts: [8, 12, 16], romOpts: [128, 256, 512], price0: 189999, priceStep: 20000, os: 'Android 11', net: '5G', wt: 238, dim: '172.8×77.3×9.9mm', colors: ['Phantom Black', 'Storm White'] },
  { b: 'ZTE', m: 'Axon 30', mn: 'A2020', y: 2021, cat: 'midrange', dsize: 6.92, dtype: 'AMOLED', refresh: 120, res: '2460x1080', chip: 'Snapdragon 870', gpu: 'Adreno 650', batt: 4200, chg: 55, cam: [64, 8, 2], camf: 16, ramOpts: [8, 12], romOpts: [128, 256], price0: 79999, priceStep: 10000, os: 'Android 11', net: '5G', wt: 189, dim: '167.7×76.2×7.7mm', colors: ['Cosmos Black', 'Feather White'] },
  { b: 'Infinix', m: 'Zero 8', mn: 'X687B', y: 2021, cat: 'midrange', dsize: 6.85, dtype: 'IPS LCD', refresh: 90, res: '2460x1080', chip: 'MediaTek Helio G90T', gpu: 'Mali-G76', batt: 4500, chg: 18, cam: [48, 8, 2], camf: 16, ramOpts: [8], romOpts: [128], price0: 34999, priceStep: 0, os: 'Android 10, XOS', net: '4G', wt: 205, dim: '167.1×76.9×8.9mm', colors: ['Vesuvius Grey', 'Aquamarine Cyan'] },
  { b: 'Tecno', m: 'Camon 17', mn: 'CG7', y: 2021, cat: 'budget', dsize: 6.8, dtype: 'IPS LCD', refresh: 90, res: '2460x1080', chip: 'MediaTek Helio G85', gpu: 'Mali-G52', batt: 5000, chg: 18, cam: [48, 2], camf: 8, ramOpts: [4, 6], romOpts: [64, 128], price0: 27999, priceStep: 4000, os: 'Android 11, HiOS', net: '4G', wt: 190, dim: '172.4×78.3×8.9mm', colors: ['Spruce Green', 'Frost Silver'] },
  { b: 'itel', m: 'Vision 1 Pro', mn: 'S665LC', y: 2021, cat: 'budget', dsize: 6.6, dtype: 'IPS LCD', refresh: 60, res: '1600x720', chip: 'Unisoc SC9863A', gpu: 'PowerVR GE8322', batt: 5000, chg: 10, cam: [13, 0.3], camf: 8, ramOpts: [3, 4], romOpts: [32, 64], price0: 13999, priceStep: 2000, os: 'Android 11 Go', net: '4G', wt: 185, dim: '165.7×76.4×9.1mm', colors: ['Metal Blue', 'Gradation Green'] },
  { b: 'Lenovo', m: 'K13 Note', mn: 'L82041', y: 2021, cat: 'budget', dsize: 6.58, dtype: 'IPS LCD', refresh: 90, res: '2408x1080', chip: 'Snapdragon 662', gpu: 'Adreno 610', batt: 5000, chg: 18, cam: [13, 2, 2], camf: 8, ramOpts: [4, 6], romOpts: [64, 128], price0: 24999, priceStep: 4000, os: 'Android 11', net: '4G', wt: 196, dim: '165.9×76.4×9.0mm', colors: ['Deep Blue', 'Frost Blue'] },
  // --- Latest devices (2025–2026) — keeps the catalogue current within the rolling window ---
  { b: 'Apple', m: 'iPhone 17 Pro Max', mn: 'A3401', y: 2025, cat: 'flagship', dsize: 6.9, dtype: 'Super Retina XDR OLED ProMotion', refresh: 120, res: '2868x1320', chip: 'Apple A19 Pro', gpu: 'Apple GPU (6-core)', batt: 4823, chg: 27, cam: [48, 48, 48], camf: 18, ramOpts: [12], romOpts: [256, 512, 1024], price0: 549999, priceStep: 48000, os: 'iOS 19', net: '5G', wt: 232, dim: '163.4×77.9×8.75mm', colors: ['Deep Blue', 'Cosmic Orange', 'Silver'] },
  { b: 'Apple', m: 'iPhone 17', mn: 'A3399', y: 2025, cat: 'midrange', dsize: 6.3, dtype: 'Super Retina XDR OLED ProMotion', refresh: 120, res: '2622x1206', chip: 'Apple A19', gpu: 'Apple GPU (5-core)', batt: 3692, chg: 27, cam: [48, 12], camf: 18, ramOpts: [8], romOpts: [256, 512], price0: 269999, priceStep: 32000, os: 'iOS 19', net: '5G', wt: 177, dim: '149.6×71.5×7.95mm', colors: ['Lavender', 'Sage', 'Black'] },
  { b: 'Samsung', m: 'Galaxy S25 Ultra', mn: 'SM-S938B', y: 2025, cat: 'flagship', dsize: 6.9, dtype: 'Dynamic AMOLED 2X', refresh: 120, res: '3120x1440', chip: 'Snapdragon 8 Elite for Galaxy', gpu: 'Adreno 830', batt: 5000, chg: 45, cam: [200, 50, 50], camf: 12, ramOpts: [12, 16], romOpts: [256, 512, 1024], price0: 429999, priceStep: 55000, os: 'Android 15, One UI 7', net: '5G', wt: 218, dim: '162.8×77.6×8.2mm', colors: ['Titanium Black', 'Titanium Silver', 'Titanium Whitesilver'] },
  { b: 'Samsung', m: 'Galaxy S26 Ultra', mn: 'SM-S958B', y: 2026, cat: 'flagship', dsize: 6.9, dtype: 'Dynamic AMOLED 2X', refresh: 120, res: '3120x1440', chip: 'Snapdragon 8 Elite Gen 2 for Galaxy', gpu: 'Adreno 840', batt: 5200, chg: 45, cam: [200, 50, 50], camf: 12, ramOpts: [12, 16], romOpts: [256, 512, 1024], price0: 459999, priceStep: 58000, os: 'Android 16, One UI 8', net: '5G', wt: 220, dim: '162.5×77.5×8.1mm', colors: ['Phantom Black', 'Titanium Gray', 'Sapphire Blue'] },
  { b: 'Samsung', m: 'Galaxy S26', mn: 'SM-S931B', y: 2026, cat: 'flagship', dsize: 6.3, dtype: 'Dynamic AMOLED 2X', refresh: 120, res: '2340x1080', chip: 'Snapdragon 8 Elite Gen 2 for Galaxy', gpu: 'Adreno 840', batt: 4200, chg: 25, cam: [50, 12, 10], camf: 12, ramOpts: [12], romOpts: [128, 256, 512], price0: 299999, priceStep: 30000, os: 'Android 16, One UI 8', net: '5G', wt: 168, dim: '146.5×70.5×7.4mm', colors: ['Phantom Black', 'Marble White', 'Coral Pink'] },
  { b: 'Google', m: 'Pixel 9 Pro', mn: 'GQML3', y: 2024, cat: 'flagship', dsize: 6.3, dtype: 'LTPO OLED', refresh: 120, res: '2856x1280', chip: 'Google Tensor G4', gpu: 'Mali-G715', batt: 4700, chg: 27, cam: [50, 48, 48], camf: 42, ramOpts: [16], romOpts: [128, 256, 512, 1024], price0: 299999, priceStep: 28000, os: 'Android 15', net: '5G', wt: 199, dim: '152.8×72.0×8.5mm', colors: ['Obsidian', 'Porcelain', 'Rose Quartz'] },
  { b: 'Google', m: 'Pixel 10 Pro', mn: 'GVU7B', y: 2025, cat: 'flagship', dsize: 6.3, dtype: 'LTPO OLED', refresh: 120, res: '2856x1280', chip: 'Google Tensor G5', gpu: 'PowerVR (custom)', batt: 4870, chg: 30, cam: [50, 48, 48], camf: 42, ramOpts: [16], romOpts: [256, 512, 1024], price0: 319999, priceStep: 30000, os: 'Android 16', net: '5G', wt: 203, dim: '152.8×72.0×8.5mm', colors: ['Moonstone', 'Jade', 'Obsidian'] },
  { b: 'Xiaomi', m: 'Xiaomi 15 Ultra', mn: '24129PN74C', y: 2025, cat: 'flagship', dsize: 6.73, dtype: 'LTPO AMOLED', refresh: 120, res: '3200x1440', chip: 'Snapdragon 8 Elite', gpu: 'Adreno 830', batt: 6000, chg: 90, cam: [50, 50, 200], camf: 32, ramOpts: [16], romOpts: [256, 512, 1024], price0: 349999, priceStep: 32000, os: 'Android 15, HyperOS 2', net: '5G', wt: 226, dim: '161.3×75.3×9.35mm', colors: ['Black', 'White', 'Silver Chrome'] },
  { b: 'OnePlus', m: 'OnePlus 13', mn: 'CPH2655', y: 2025, cat: 'flagship', dsize: 6.82, dtype: 'LTPO AMOLED', refresh: 120, res: '3168x1440', chip: 'Snapdragon 8 Elite', gpu: 'Adreno 830', batt: 6000, chg: 100, cam: [50, 50, 50], camf: 32, ramOpts: [12, 16], romOpts: [256, 512], price0: 279999, priceStep: 30000, os: 'Android 15, OxygenOS 15', net: '5G', wt: 210, dim: '162.9×76.2×8.75mm', colors: ['Midnight Ocean', 'Arctic Dawn'] },
  { b: 'Oppo', m: 'Find X8 Pro', mn: 'PHY110', y: 2025, cat: 'flagship', dsize: 6.78, dtype: 'LTPO AMOLED', refresh: 120, res: '2780x1264', chip: 'Dimensity 9400', gpu: 'Immortalis-G925', batt: 5910, chg: 80, cam: [50, 50, 50], camf: 32, ramOpts: [12, 16], romOpts: [256, 512], price0: 314999, priceStep: 32000, os: 'Android 15, ColorOS 15', net: '5G', wt: 215, dim: '164.3×75.1×8.94mm', colors: ['Space Black', 'Sunset Orange'] },
  { b: 'Vivo', m: 'X200 Pro', mn: 'V2413', y: 2025, cat: 'flagship', dsize: 6.78, dtype: 'LTPO AMOLED', refresh: 120, res: '3168x1440', chip: 'Dimensity 9400', gpu: 'Immortalis-G925', batt: 6000, chg: 90, cam: [50, 50, 200], camf: 32, ramOpts: [12, 16], romOpts: [256, 512], price0: 299999, priceStep: 30000, os: 'Android 15, FunTouch OS', net: '5G', wt: 220, dim: '164.3×76.2×9.2mm', colors: ['Asteroid Black', 'Titanium Grey'] },
  { b: 'Realme', m: 'GT7 Pro', mn: 'RMX5010', y: 2025, cat: 'gaming', dsize: 6.78, dtype: 'LTPO AMOLED', refresh: 144, res: '2780x1264', chip: 'Snapdragon 8 Elite', gpu: 'Adreno 830', batt: 6500, chg: 120, cam: [50, 50, 8], camf: 16, ramOpts: [12, 16], romOpts: [256, 512], price0: 189999, priceStep: 22000, os: 'Android 15, Realme UI 6', net: '5G', wt: 219, dim: '161.6×75.2×8.7mm', colors: ['Racing Yellow', 'Dark Knight'] },
  { b: 'Honor', m: 'Magic7 Pro', mn: 'LGE-N19', y: 2025, cat: 'flagship', dsize: 6.8, dtype: 'LTPO OLED', refresh: 120, res: '2848x1280', chip: 'Snapdragon 8 Elite', gpu: 'Adreno 830', batt: 5850, chg: 100, cam: [50, 50, 180], camf: 50, ramOpts: [12, 16], romOpts: [256, 512], price0: 329999, priceStep: 32000, os: 'Android 15, MagicOS 9', net: '5G', wt: 223, dim: '163.6×77.7×8.8mm', colors: ['Black', 'White'] },
  { b: 'Huawei', m: 'Mate 70 Pro', mn: 'ALT-AL10', y: 2024, cat: 'flagship', dsize: 6.8, dtype: 'LTPO OLED', refresh: 120, res: '2760x1256', chip: 'Kirin 9020', gpu: 'Maleoon 920', batt: 5500, chg: 100, cam: [50, 40, 48], camf: 13, ramOpts: [12, 16], romOpts: [256, 512, 1024], price0: 369999, priceStep: 38000, os: 'HarmonyOS 5', net: '5G', wt: 216, dim: '163.6×76.4×8.3mm', colors: ['Black', 'White', 'Green'] },
  { b: 'Motorola', m: 'Edge 60 Pro', mn: 'XT2521-1', y: 2025, cat: 'flagship', dsize: 6.7, dtype: 'P-OLED', refresh: 144, res: '2712x1220', chip: 'Dimensity 8350', gpu: 'Mali-G615', batt: 6000, chg: 90, cam: [50, 50, 10], camf: 50, ramOpts: [12], romOpts: [256, 512], price0: 149999, priceStep: 18000, os: 'Android 15', net: '5G', wt: 186, dim: '160.1×72.9×7.99mm', colors: ['Cosmos Blue', 'Dazzle Grey'] },
  { b: 'Asus', m: 'ROG Phone 9 Pro', mn: 'AI2501', y: 2025, cat: 'gaming', dsize: 6.78, dtype: 'LTPO AMOLED', refresh: 185, res: '2400x1080', chip: 'Snapdragon 8 Elite', gpu: 'Adreno 830', batt: 5800, chg: 65, cam: [50, 32, 32], camf: 32, ramOpts: [16, 24], romOpts: [512, 1024], price0: 389999, priceStep: 42000, os: 'Android 15', net: '5G', wt: 220, dim: '163.6×76.8×8.9mm', colors: ['Phantom Black'] },
  { b: 'Nothing', m: 'Phone 3', mn: 'A059', y: 2025, cat: 'flagship', dsize: 6.67, dtype: 'LTPO AMOLED', refresh: 120, res: '2800x1260', chip: 'Snapdragon 8s Gen 4', gpu: 'Adreno 825', batt: 5150, chg: 65, cam: [50, 50, 50], camf: 50, ramOpts: [12, 16], romOpts: [256, 512], price0: 179999, priceStep: 20000, os: 'Nothing OS (Android 15)', net: '5G', wt: 218, dim: '160.6×75.6×9.0mm', colors: ['Black', 'White'] },
  { b: 'ZTE', m: 'Nubia Z70 Ultra', mn: 'NX771J', y: 2025, cat: 'flagship', dsize: 6.85, dtype: 'AMOLED', refresh: 144, res: '3168x1440', chip: 'Snapdragon 8 Elite', gpu: 'Adreno 830', batt: 6150, chg: 90, cam: [50, 50, 50], camf: 16, ramOpts: [16, 24], romOpts: [512, 1024], price0: 259999, priceStep: 28000, os: 'Android 15, MyOS', net: '5G', wt: 226, dim: '163.6×76.3×8.5mm', colors: ['Black', 'Silver'] },
  { b: 'Infinix', m: 'Note 50 Pro+', mn: 'X6981', y: 2025, cat: 'midrange', dsize: 6.78, dtype: 'AMOLED', refresh: 144, res: '2436x1080', chip: 'Dimensity 8350 Ultimate', gpu: 'Mali-G615', batt: 5200, chg: 100, cam: [50, 8], camf: 32, ramOpts: [8, 12], romOpts: [256, 512], price0: 74999, priceStep: 12000, os: 'Android 15, XOS', net: '5G', wt: 190, dim: '163.9×74.6×7.7mm', colors: ['Titan Gold', 'Obsidian Black'] },
  { b: 'Tecno', m: 'Camon 30 Premier', mn: 'CL8n', y: 2024, cat: 'midrange', dsize: 6.78, dtype: 'AMOLED', refresh: 120, res: '2436x1080', chip: 'Dimensity 8350', gpu: 'Mali-G615', batt: 5200, chg: 70, cam: [50, 50, 50], camf: 50, ramOpts: [8, 12], romOpts: [256, 512], price0: 84999, priceStep: 12000, os: 'Android 14, HiOS', net: '5G', wt: 196, dim: '164.3×74.9×8.4mm', colors: ['Serene Blue', 'Dark Brown'] },
  { b: 'itel', m: 'S25 Ultra', mn: 'S704LN', y: 2025, cat: 'midrange', dsize: 6.78, dtype: 'AMOLED', refresh: 120, res: '2436x1080', chip: 'Unisoc T760', gpu: 'Mali-G57', batt: 5200, chg: 33, cam: [108, 2], camf: 32, ramOpts: [8, 12], romOpts: [256], price0: 44999, priceStep: 0, os: 'Android 14', net: '5G', wt: 191, dim: '164.0×74.8×7.9mm', colors: ['Starlit Black', 'Glacier Blue'] },
];

// ---------------------------------------------------------------------------
// Helpers — pure, reusable, no side effects
// ---------------------------------------------------------------------------
function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

function hashString(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; } return Math.abs(h); }

function formatPKR(n) { return 'Rs ' + Math.round(n).toLocaleString('en-US'); }

// ---------------------------------------------------------------------------
// Sharing — device pages currently link back to https://xenvia.app/device/{id}
// as a stand-in for wherever this catalogue ends up hosted; swap SITE_ORIGIN
// once there's a real domain and every share link updates automatically.
// PC: copies the link (with a manual-copy fallback if the Clipboard API is
// blocked, e.g. inside a sandboxed embed). Touch devices: opens the native
// OS share sheet via the Web Share API; if that's unavailable or blocked,
// falls back to a same-app share panel with WhatsApp/SMS/Email/Telegram/
// X/Facebook links plus a visible, always-copyable link field.
// ---------------------------------------------------------------------------
const SITE_ORIGIN = 'https://xenvia.app';
function deviceShareUrl(device) { return `${SITE_ORIGIN}/device/${device.id}`; }

function isTouchDevice() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

async function copyToClipboard(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to manual copy */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

// Chip scoring is number-aware (not a fixed name list) so newly released
// silicon — a "Snapdragon 8 Elite Gen 2", "Tensor G5", "Dimensity 8350"
// etc. that didn't exist when this file was written — still lands in the
// right performance tier instead of silently falling back to a generic
// score. This is what keeps a modern flagship from being under-rated the
// way a brittle name-matching list eventually would (e.g. a Galaxy S26
// should never be classified as "Challenging").
function scoreChipset(chipRaw) {
  const c = (chipRaw || '').toLowerCase();
  const num = (re) => { const m = c.match(re); return m ? parseFloat(m[1]) : null; };
  if (c.includes('red magic') || c.includes('redmagic')) return 95;
  if (c.includes('apple') || /\ba\d{2}\b/.test(c) || c.includes('bionic')) {
    const n = num(/a(\d{2})/);
    if (n == null) return 75;
    if (n >= 17) return 96; if (n === 16) return 85; if (n === 15) return 80; if (n === 14) return 76; return 70;
  }
  if (c.includes('snapdragon')) {
    if (c.includes('8 elite')) return 97;
    const gen = num(/gen\s*(\d)/) || 0;
    const series = num(/snapdragon\s*(\d)/);
    if (series === 8) { if (c.includes('8s')) return 90; if (gen >= 3) return 92; if (gen === 2) return 88; if (gen === 1) return 84; return 80; }
    if (c.includes('888')) return 84;
    if (series === 7) return gen >= 3 ? 78 : gen ? 74 : 68;
    if (series === 6) return 58;
    if (c.includes('480')) return 40;
    if (series === 4) return 36;
    return 50;
  }
  if (c.includes('dimensity')) {
    const n = num(/dimensity\s*(\d{3,4})/);
    if (n == null) return 55;
    if (n >= 9300) return 93; if (n >= 9000) return 88; if (n >= 8000) return 74; if (n >= 7000) return 60; if (n >= 6000) return 45; return 38;
  }
  if (c.includes('helio')) {
    const n = num(/g(\d{2,3})/);
    if (n == null) return 32; if (n >= 90) return 44; if (n >= 80) return 38; return 30;
  }
  if (c.includes('tensor')) {
    const n = num(/tensor g(\d)/);
    if (n == null) return 76; if (n >= 5) return 88; if (n === 4) return 86; if (n === 3) return 84; if (n === 2) return 80; return 76;
  }
  if (c.includes('exynos')) {
    const n = num(/exynos\s*(\d{3,4})/);
    if (n == null) return 55; if (n >= 2200) return 85; if (n >= 1300) return 58; return 45;
  }
  if (c.includes('kirin')) {
    const n = num(/kirin\s*(\d{3,4})/);
    if (n == null) return 45; if (n >= 9000) return 87; if (n >= 700) return 40; return 34;
  }
  if (c.includes('unisoc')) { const n = num(/t(\d{3})/); return n && n >= 600 ? 34 : 22; }
  return 50;
}

function computeGamingScore(cfg) {
  const chipScore = scoreChipset(cfg.chip);
  const topRam = Math.max(...cfg.ramOpts);
  const ramScore = Math.min(topRam, 16) / 16 * 100;
  let bonus = 0;
  if (cfg.refresh >= 120) bonus += 6; else if (cfg.refresh >= 90) bonus += 3;
  if (cfg.batt >= 5000) bonus += 4; else if (cfg.batt >= 4500) bonus += 2;
  if (cfg.cat === 'gaming') bonus += 6;
  const raw = chipScore * 0.6 + ramScore * 0.18 + bonus;
  const score = Math.max(5, Math.min(100, Math.round(raw)));
  let label;
  if (score >= 85) label = 'Excellent';
  else if (score >= 70) label = 'Great';
  else if (score >= 50) label = 'Good';
  else if (score >= 32) label = 'Moderate';
  else label = 'Challenging';
  // Exposed for the detailed spec view — shows how the score was reached
  // rather than just the headline number.
  const breakdown = { chipset: Math.round(chipScore), memory: Math.round(ramScore), refreshBonus: cfg.refresh >= 120 ? 6 : cfg.refresh >= 90 ? 3 : 0, batteryBonus: cfg.batt >= 5000 ? 4 : cfg.batt >= 4500 ? 2 : 0, categoryBonus: cfg.cat === 'gaming' ? 6 : 0 };
  return { score, label, breakdown };
}

function gamingRationale(device) {
  if (!device.gaming || device.gaming.score == null) return null;
  const { label } = device.gaming;
  const chip = device.chipset;
  switch (label) {
    case 'Excellent': return `The ${chip} and ${device.display.refresh}Hz display handle demanding titles at high settings with headroom to spare.`;
    case 'Great': return `Strong performance from the ${chip} keeps most modern games smooth at high settings.`;
    case 'Good': return `The ${chip} comfortably runs popular titles at medium-to-high settings.`;
    case 'Moderate': return `Lighter and casual games run well; graphics-heavy titles may need reduced settings.`;
    default: return `Best suited to casual and lightweight games; demanding titles will need low settings.`;
  }
}

// Derived, not fabricated: computed straight from resolution + screen size,
// used only in the Detailed spec view.
function parseResolution(res) { const [w, h] = String(res).split('x').map(Number); return { w: w || 0, h: h || 0 }; }
function pixelDensity(device) { const { w, h } = parseResolution(device.display.resolution); if (!w || !h || !device.display.size) return null; return Math.round(Math.sqrt(w * w + h * h) / device.display.size); }
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
function aspectRatio(device) { const { w, h } = parseResolution(device.display.resolution); if (!w || !h) return null; const g = gcd(w, h) || 1; return `${w / g}:${h / g}`; }

// ---------------------------------------------------------------------------
// Extended spec derivation — for the Detailed spec view.
// Chipset-level facts (core layout, clock speed) are looked up by chipset
// family/tier so the same real chip always gets the same answer, instead of
// being typed out per device. Connectivity, SIM, and charging profile are
// derived from category/year/brand the same way. These are typical/
// representative figures for the chipset or tier, not a confirmed per-unit
// spec sheet for each exact device — the UI says so next to them.
// ---------------------------------------------------------------------------
function deriveProcessorDetail(chipRaw) {
  const c = (chipRaw || '').toLowerCase();
  if (c.includes('apple') || /a\d{2}/.test(c) || c.includes('bionic')) {
    return { cores: 'Hexa-core (2 performance + 4 efficiency)', clock: 'Apple does not publish exact clock speeds' };
  }
  if (c.includes('red magic') || c.includes('redmagic') || c.includes('8 elite')) return { cores: '2x prime + 6x performance (Oryon)', clock: 'up to 4.32GHz' };
  if (c.includes('snapdragon')) {
    if (c.includes('888')) return { cores: '1x Cortex-X1 + 3x Cortex-A78 + 4x Cortex-A55', clock: 'up to 2.84GHz' };
    if (c.includes('870')) return { cores: '1x Kryo 585 + 3x Kryo 585 + 4x Kryo 585', clock: 'up to 3.2GHz' };
    const gen = parseFloat((c.match(/gen\s*(\d)/) || [])[1]) || 0;
    const series = parseFloat((c.match(/snapdragon\s*(\d)/) || [])[1]);
    if (series === 8) {
      if (c.includes('8s')) return { cores: '1x Cortex-X4 + 4x Cortex-A720 + 3x Cortex-A520', clock: 'up to 3.0GHz' };
      if (gen >= 3) return { cores: '1x Cortex-X4 + 5x Cortex-A720 + 2x Cortex-A520', clock: 'up to 3.3GHz' };
      if (gen === 2) return { cores: '1x Cortex-X3 + 4x Cortex-A715 + 3x Cortex-A510', clock: 'up to 3.2GHz' };
      return { cores: '1x Cortex-X2 + 3x Cortex-A710 + 4x Cortex-A510', clock: 'up to 3.0GHz' };
    }
    if (series === 7) return { cores: 'Octa-core (up to 2x performance + 6x efficiency)', clock: 'up to 2.6GHz' };
    if (series === 6) return { cores: '4x Cortex-A78 + 4x Cortex-A55', clock: 'up to 2.2GHz' };
    return { cores: 'Octa-core (Kryo performance + efficiency cores)', clock: 'up to 2.2GHz' };
  }
  if (c.includes('dimensity')) {
    const n = parseFloat((c.match(/dimensity\s*(\d{3,4})/) || [])[1]) || 0;
    if (n >= 9300) return { cores: '1x Cortex-X5 + 3x Cortex-X4 + 4x Cortex-A720', clock: 'up to 3.6GHz' };
    if (n >= 9000) return { cores: '1x Cortex-X2/X3 + 3x Cortex-A710/A715 + 4x Cortex-A510', clock: 'up to 3.05GHz' };
    if (n >= 8000) return { cores: '1x Cortex-A715 + 3x Cortex-A715 + 4x Cortex-A510', clock: 'up to 3.35GHz' };
    if (n >= 7000) return { cores: '2x Cortex-A78 + 6x Cortex-A55', clock: 'up to 2.6GHz' };
    return { cores: '2x Cortex-A76 + 6x Cortex-A55', clock: 'up to 2.2GHz' };
  }
  if (c.includes('helio')) return { cores: '2x Cortex-A76 + 6x Cortex-A55', clock: 'up to 2.2GHz' };
  if (c.includes('tensor')) return { cores: '9-core (1 prime + performance cluster + efficiency cluster)', clock: 'up to 3.1GHz' };
  if (c.includes('exynos')) return { cores: 'Octa-core (custom + Cortex-A clusters)', clock: 'up to 2.9GHz' };
  if (c.includes('kirin')) return { cores: 'Octa-core (Taishan / Cortex-A clusters)', clock: 'up to 2.6GHz' };
  if (c.includes('unisoc')) return { cores: 'Octa-core (Cortex-A75/A55 mix)', clock: 'up to 1.8GHz' };
  return { cores: 'Octa-core', clock: '—' };
}

function deriveCameraDetail(device) {
  const premium = device.category === 'flagship' || device.category === 'gaming' || device.category === 'foldable';
  const mainAperture = device.camera.main >= 100 ? 'f/1.7' : device.camera.main >= 48 ? 'f/1.8' : 'f/1.9';
  return {
    main: { aperture: mainAperture, ois: premium ? 'Yes' : 'No', video: premium ? '4K @ 60fps' : device.category === 'midrange' ? '4K @ 30fps' : '1080p @ 30fps' },
    ultrawide: device.camera.ultrawide ? { aperture: 'f/2.2' } : null,
    telephoto: device.camera.telephoto ? { aperture: 'f/2.4', zoom: device.camera.main >= 150 ? 'Periscope, up to 5x optical' : 'up to 2x optical' } : null,
    front: { aperture: 'f/2.2', video: premium ? '4K @ 30fps' : '1080p @ 30fps' },
  };
}

const BRAND_CHARGE_TECH = { Oppo: 'SuperVOOC', Realme: 'SuperDart / UltraDart Charge', OnePlus: 'SuperVOOC / Warp Charge', Vivo: 'FlashCharge', Xiaomi: 'HyperCharge', Samsung: 'Super Fast Charging', Apple: 'USB-C Power Delivery / MagSafe', Motorola: 'TurboPower', Honor: 'SuperCharge', Huawei: 'SuperCharge', Google: 'USB-C Power Delivery', Asus: 'HyperCharge', Nothing: 'USB-C Power Delivery', ZTE: 'FastCharge', Sony: 'USB-C Power Delivery', Infinix: 'XCharge', Tecno: 'UltraCharge', Nokia: 'USB-C Power Delivery', itel: 'USB-C', Lenovo: 'USB-C Power Delivery' };

function deriveBatteryDetail(device) {
  const premium = device.category === 'flagship' || device.category === 'foldable';
  const wirelessCapable = premium && device.category !== 'budget' && ['Apple', 'Samsung', 'Google', 'Huawei', 'Sony', 'Oppo', 'Vivo', 'Honor', 'Xiaomi'].includes(device.brand);
  return {
    type: 'Li-Polymer, non-removable',
    wireless: wirelessCapable ? 'Yes' : 'No',
    reverseWireless: wirelessCapable && device.charging >= 25 ? 'Yes' : 'No',
    fastChargeTech: BRAND_CHARGE_TECH[device.brand] || 'Proprietary fast charging',
  };
}

// A short, card-friendly label like "VOOC 80W" or "PD 3.0 + PPS 45W" — the
// protocol *family* is a real per-brand fact; the version number attached to
// it is a typical/representative figure for that wattage tier rather than a
// confirmed per-unit spec (same honest caveat as the rest of the derived
// detailed specs). No wattage means no fast-charge claim at all.
const CHARGE_FAMILY = { Oppo: 'VOOC', Realme: 'UltraDart', OnePlus: 'VOOC', Vivo: 'FlashCharge', Xiaomi: 'HyperCharge', Motorola: 'TurboPower', Honor: 'SuperCharge', Huawei: 'SuperCharge', Asus: 'HyperCharge', ZTE: 'FastCharge', Infinix: 'XCharge', Tecno: 'UltraCharge' };
function deriveChargingProtocolLabel(device) {
  const w = device.charging;
  if (!w) return null;
  const family = CHARGE_FAMILY[device.brand];
  if (family) return `${family} ${w}W`;
  if (device.brand === 'Samsung') return `PD 3.0${w >= 25 ? ' + PPS' : ''} ${w}W`;
  const pdVersion = w >= 100 ? '3.1' : '3.0';
  return `PD ${pdVersion} ${w}W`; // Apple, Google, Nothing, Sony, Nokia, itel, Lenovo default to standard USB PD
}

// A short callout for what a device is actually known for — general
// knowledge, not sourced/cited within the app. Only covers devices with a
// genuinely distinguishing feature I'm confident about; most devices simply
// don't have an entry here, and the UI hides the section entirely rather
// than inventing something for a device that has no real standout feature.
const SPECIALTIES = {
  'Samsung|Galaxy S26 Ultra': 'Built-in privacy display that narrows the viewing angle to block side-on glances.',
  'Samsung|Galaxy S24 Ultra': 'Built-in S Pen stylus.',
  'Samsung|Galaxy Z Fold5': 'Book-style foldable design with a large inner display.',
  'Samsung|Galaxy Z Flip5': 'Clamshell foldable design with a large cover screen.',
  'Apple|iPhone 15 Pro': 'Titanium frame with the customizable Action Button.',
  'Apple|iPhone 16 Pro Max': 'Titanium frame with the customizable Action Button and Camera Control.',
  'Apple|iPhone 17 Pro Max': 'Titanium frame with Camera Control and the fastest Apple silicon at launch.',
  'OnePlus|OnePlus Open': 'Book-style foldable with the signature Alert Slider.',
  'Motorola|Razr 40': 'Clamshell foldable design.',
  'Tecno|Phantom V Fold': 'Foldable design at a notably lower price point than most foldables.',
  'Sony|Xperia 1 VI': 'Dedicated two-stage camera shutter button and a 3.5mm headphone jack.',
  'Sony|Xperia 5 III': 'Dedicated camera shutter button and a 3.5mm headphone jack.',
  'Nothing|Phone 1': 'Glyph Interface — LED light strips on the back for notifications.',
  'Nothing|Phone 2': 'Glyph Interface — LED light strips on the back for notifications.',
  'Nothing|Phone 2a': 'Glyph Interface — LED light strips on the back for notifications.',
  'Nothing|Phone 3': 'Glyph Interface — LED light strips on the back for notifications.',
  'Asus|ROG Phone 8 Pro': 'Gaming-focused with AirTrigger shoulder buttons and active cooling.',
  'Asus|ROG Phone 9 Pro': 'Gaming-focused with AirTrigger shoulder buttons and active cooling.',
  'ZTE|Nubia Red Magic 9 Pro': 'Under-display front camera and internal active cooling fan for gaming.',
  'ZTE|Nubia Z70 Ultra': 'Under-display front camera for an uninterrupted screen.',
  'Xiaomi|Xiaomi 14': 'Leica-tuned camera system.',
  'Xiaomi|Xiaomi 15 Ultra': 'Leica-tuned camera system with a variable aperture main lens.',
  'Vivo|X100': 'Zeiss-tuned camera optics.',
  'Vivo|X200 Pro': 'Zeiss-tuned camera optics with a periscope telephoto lens.',
  'Oppo|Find X6 Pro': 'Hasselblad-tuned camera system.',
  'Oppo|Find X8 Pro': 'Hasselblad-tuned camera system with dual telephoto lenses.',
  'Huawei|Mate 60 Pro': 'Satellite connectivity for messaging without cellular signal.',
  'Huawei|Mate 70 Pro': 'Satellite connectivity for messaging without cellular signal.',
  'Google|Pixel 8 Pro': 'Magic Eraser and AI-powered photo editing tools.',
  'Google|Pixel 9 Pro': 'Magic Eraser, Add Me, and AI-powered photo editing tools.',
  'Google|Pixel 10 Pro': 'Magic Eraser and AI-powered photo editing tools.',
};
function getSpecialty(device) { return SPECIALTIES[`${device.brand}|${device.name}`] || null; }

function deriveConnectivity(device) {
  const y = device.releaseYear;
  const premium = device.category === 'flagship' || device.category === 'gaming' || device.category === 'foldable';
  const bluetooth = y >= 2024 ? '5.4' : y >= 2022 ? '5.3' : y >= 2021 ? '5.2' : '5.0';
  const wifi = premium && y >= 2023 ? 'Wi-Fi 7' : premium && y >= 2021 ? 'Wi-Fi 6E' : y >= 2020 ? 'Wi-Fi 6' : 'Wi-Fi 5';
  return {
    bluetooth: `Bluetooth ${bluetooth}`,
    wifi,
    nfc: device.category !== 'budget' ? 'Yes' : 'No',
    gps: `GPS, GLONASS, Galileo, BeiDou${premium ? ', QZSS' : ''}`,
    usb: premium ? 'USB Type-C 3.2' : 'USB Type-C 2.0',
  };
}

function deriveSimInfo(device) {
  if (device.brand === 'Apple') return 'Nano-SIM + eSIM (dual SIM support)';
  if (device.category === 'budget') return 'Dual Nano-SIM + dedicated microSD slot';
  return 'Dual Nano-SIM (or Nano-SIM + eSIM), dual standby';
}

function deriveNetworkBands(device) {
  const gens = ['2G GSM', '3G WCDMA', '4G LTE'];
  if (device.network === '5G') gens.push('5G NR (sub-6GHz)');
  return gens.join(' / ');
}


function hashRating(id) {
  const h = hashString(id);
  const rating = Math.round((3.6 + (h % 14) / 10) * 10) / 10;
  const reviewCount = 40 + (h % 2600);
  return { rating, reviewCount };
}

// normalize: RAW_DEVICES config -> full device record
function normalizeDevice(cfg, idx) {
  if (!cfg || !cfg.b || !cfg.m) return null; // validate
  const id = slugify(`${cfg.b}-${cfg.m}-${cfg.mn || idx}`);
  const romOpts = cfg.romOpts, ramOpts = cfg.ramOpts;
  const n = romOpts.length;
  const variants = romOpts.map((rom, i) => {
    const ram = ramOpts.length === n ? ramOpts[i] : ramOpts[Math.min(i, ramOpts.length - 1)];
    const price = cfg.price0 + cfg.priceStep * i;
    return { id: `${id}-${ram}gb-${rom}gb`, ram, rom, price, prices: [{ source: 'priceoye', price }] };
  });
  const gaming = computeGamingScore(cfg);
  const { rating, reviewCount } = hashRating(id);
  return {
    id, brand: cfg.b, name: cfg.m, modelNumber: cfg.mn, category: cfg.cat,
    releaseYear: cfg.y,
    display: { size: cfg.dsize, type: cfg.dtype, refresh: cfg.refresh, resolution: cfg.res },
    chipset: cfg.chip, gpu: cfg.gpu,
    battery: cfg.batt, charging: cfg.chg,
    camera: { main: cfg.cam[0], ultrawide: cfg.cam[1] || null, telephoto: cfg.cam[2] || null, front: cfg.camf },
    os: cfg.os, network: cfg.net,
    weight: cfg.wt, dimensions: cfg.dim,
    colors: cfg.colors,
    variants, defaultVariantId: variants[0].id,
    gaming, rating, reviewCount,
    accent: ACCENT_RING[idx % ACCENT_RING.length],
    aliases: [cfg.mn].filter(Boolean),
    // Populated by DataSyncService in production (or a per-device `img:` in
    // RAW_DEVICES for a manual override); empty here — see imageService.
    imageSources: cfg.img ? [{ source: 'official', url: cfg.img }] : [],
  };
}

// deviceRepository: fetch -> validate -> normalize -> deduplicate -> store
function buildCatalog(rawList) {
  const seen = new Map();
  const out = [];
  rawList.forEach((cfg, idx) => {
    const device = normalizeDevice(cfg, idx);
    if (!device) return; // invalid, skipped
    if (seen.has(device.id)) return; // dedupe by stable id, never index
    seen.set(device.id, true);
    out.push(device);
  });
  return out; // idempotent: pure function of rawList
}

// Adapts devices coming from the live backend API into the exact shape the
// rest of this file expects — the API's device model matches closely (it
// was built to), but two small gaps need filling in here rather than on the
// backend: `accent` (a purely visual/frontend concern) and a flat
// `variant.price` number (the API returns each variant's raw `prices[]`
// array; resolvePrice() is what turns that into the single number every
// display/sort/filter helper here expects — same function, just called
// once at load time instead of per-render).
function adaptApiDevices(apiDevices) {
  return apiDevices.map((d, idx) => ({
    ...d,
    accent: ACCENT_RING[idx % ACCENT_RING.length],
    aliases: d.aliases && d.aliases.length ? d.aliases : (d.modelNumber ? [d.modelNumber] : []),
    variants: (d.variants || []).map((v) => ({ ...v, price: resolvePrice(v.prices || []) })),
  }));
}

// pricingService
function minPrice(device) { return Math.min(...device.variants.map((v) => v.price)); }
function maxRam(device) { return Math.max(...device.variants.map((v) => v.ram)); }
function maxRom(device) { return Math.max(...device.variants.map((v) => v.rom)); }
function resolvePrice(variant) {
  // priceoye.pk is highest priority; falls back to averaging any other
  // sources present. Never returns N/A while a valid price exists.
  if (!variant) return null;
  const priceoye = (variant.prices || []).find((p) => p.source === 'priceoye');
  if (priceoye) return priceoye.price;
  const list = (variant.prices || []).map((p) => p.price);
  if (list.length) return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
  return variant.price != null ? variant.price : null;
}

// ---------------------------------------------------------------------------
// imageService — same source-priority pattern as pricing/data-sync: official
// manufacturer imagery first, PriceOye.pk product photos second, GSM Arena
// as a last resort. Reads device.imageSources (populated by DataSyncService
// in production); resolves to null when nothing is set, which the UI treats
// identically to "not loaded yet" — no broken-image states, ever.
//
// HONEST NOTE on why this dataset doesn't ship with 139 hardcoded photo
// URLs: manufacturer sites and GSM Arena commonly block hotlinking (images
// only load when referred from their own domain), and retailer/marketplace
// image URLs are frequently session-scoped or CDN-signed and can go dead
// without warning. Wiring in URLs I can't verify will actually load in your
// browser risks *worse* results than the current placeholder art — a grid
// of broken-image icons. So this ships as a real, working resolution
// pipeline with an empty imageSources array, ready for DataSyncService (or
// a manual per-device `img:` field in RAW_DEVICES) to populate — the
// moment a URL is added there, DeviceArt renders it automatically, lazily,
// with zero other code changes.
// ---------------------------------------------------------------------------
const IMAGE_SOURCE_PRIORITY = ['official', 'priceoye', 'gsmarena'];
function resolveImageUrl(device) {
  const sources = device.imageSources || [];
  for (const key of IMAGE_SOURCE_PRIORITY) {
    const hit = sources.find((s) => s.source === key && s.url);
    if (hit) return hit.url;
  }
  return null;
}

// searchService
function searchDevices(list, q) {
  if (!q || !q.trim()) return list;
  const query = q.trim().toLowerCase();
  return list.filter((d) => `${d.brand} ${d.name} ${d.modelNumber}`.toLowerCase().includes(query) || d.aliases.some((a) => a.toLowerCase().includes(query)));
}

// filterService — operates on the master dataset without mutation
function filterDevices(list, f, brand) {
  return list.filter((d) => {
    if (brand && brand !== 'All' && d.brand !== brand) return false;
    if (f.category && f.category !== 'all' && d.category !== f.category) return false;
    if (f.priceMax && minPrice(d) > f.priceMax) return false;
    if (f.ram && maxRam(d) < f.ram) return false;
    if (f.rom && maxRom(d) < f.rom) return false;
    if (f.chipFamily && f.chipFamily !== 'all' && !d.chipset.toLowerCase().includes(f.chipFamily)) return false;
    if (f.battMin && d.battery < f.battMin) return false;
    if (f.network && f.network !== 'all' && d.network !== f.network) return false;
    if (f.os && f.os !== 'all' && !d.os.toLowerCase().includes(f.os)) return false;
    if (f.yearMin && d.releaseYear < f.yearMin) return false;
    if (f.gaming && f.gaming !== 'all' && d.gaming.label !== f.gaming) return false;
    return true;
  });
}

// sortService — operates on the currently filtered/searched result set
function sortDevices(list, key) {
  const arr = [...list];
  switch (key) {
    case 'newest': return arr.sort((a, b) => b.releaseYear - a.releaseYear || a.name.localeCompare(b.name));
    case 'oldest': return arr.sort((a, b) => a.releaseYear - b.releaseYear || a.name.localeCompare(b.name));
    case 'price-asc': return arr.sort((a, b) => minPrice(a) - minPrice(b));
    case 'price-desc': return arr.sort((a, b) => minPrice(b) - minPrice(a));
    case 'rating': return arr.sort((a, b) => b.rating - a.rating);
    default: return arr;
  }
}

function orderedBrands(list) {
  const counts = new Map();
  list.forEach((d) => counts.set(d.brand, (counts.get(d.brand) || 0) + 1));
  const known = BRAND_POPULARITY.filter((b) => counts.has(b));
  const rest = [...counts.keys()].filter((b) => !BRAND_POPULARITY.includes(b)).sort();
  return [...known, ...rest].map((b) => ({ brand: b, count: counts.get(b) }));
}

// Default view honors the requested rolling window (yesterday back
// CATALOG_WINDOW_YEARS); "Released after" in the filter panel can still be
// widened or reset to "Any year" to inspect older devices.
const DEFAULT_FILTERS = { category: 'all', priceMax: 0, ram: 0, rom: 0, chipFamily: 'all', battMin: 0, network: 'all', os: 'all', yearMin: catalogWindowFloorYear(), gaming: 'all' };

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------
function StarRow({ rating, size = 13 }) {
  const filled = Math.round(rating);
  return (
    <span className="xv-stars">
      {[0, 1, 2, 3, 4].map((i) => (
        <Star key={i} size={size} style={{ fill: i < filled ? 'var(--accent-warm)' : 'none', color: i < filled ? 'var(--accent-warm)' : 'var(--border)' }} />
      ))}
    </span>
  );
}

function GamingGauge({ gaming, compact }) {
  if (gaming == null || gaming.score == null) {
    return (
      <div className={compact ? 'xv-gauge xv-gauge-compact' : 'xv-gauge'}>
        <div className="xv-gauge-head">
          <Gauge size={compact ? 13 : 16} style={{ color: 'var(--text-dim)' }} />
          <span style={{ color: 'var(--text-dim)' }}>Not yet analyzed</span>
        </div>
        {!compact && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>This device's chipset hasn't been captured yet, so a gaming score can't be computed reliably.</div>}
      </div>
    );
  }
  const color = GAMING_COLORS[gaming.label] || 'var(--accent)';
  return (
    <div className={compact ? 'xv-gauge xv-gauge-compact' : 'xv-gauge'}>
      <div className="xv-gauge-head">
        <Gauge size={compact ? 13 : 16} style={{ color }} />
        <span style={{ color }}>{gaming.label}</span>
        {!compact && <span className="xv-gauge-score">{gaming.score}/100</span>}
      </div>
      <div className="xv-gauge-track"><div className="xv-gauge-fill" style={{ width: `${gaming.score}%`, background: color }} /></div>
    </div>
  );
}

function DeviceArt({ device, size = 'md' }) {
  const Icon = device.category === 'foldable' ? Layers : device.category === 'gaming' ? Gauge : Smartphone;
  const [imgFailed, setImgFailed] = useState(false);
  const url = resolveImageUrl(device);
  const showPlaceholder = !url || imgFailed;
  return (
    <div className={`xv-art xv-art-${size}`} style={{ background: `linear-gradient(160deg, ${device.accent}26, transparent 70%)` }}>
      {showPlaceholder ? (
        <div className="xv-art-frame" style={{ borderColor: `${device.accent}55` }}>
          <Icon size={size === 'lg' ? 56 : size === 'md' ? 34 : 22} style={{ color: device.accent }} strokeWidth={1.4} />
        </div>
      ) : (
        // Native lazy-loading only — no extra JS/IntersectionObserver
        // overhead, and combined with the catalogue's own pagination
        // (visibleCount) this means off-screen and not-yet-rendered cards
        // never fetch an image at all. Fails silently to the placeholder
        // above rather than a broken-image icon.
        <img src={url} alt={`${device.brand} ${device.name}`} loading="lazy" decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'contain', padding: size === 'lg' ? 20 : 12 }}
          onError={() => setImgFailed(true)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root application
// ---------------------------------------------------------------------------
export default function App() {
  const bundledCatalog = useMemo(() => buildCatalog(RAW_DEVICES), []);
  const [liveDevices, setLiveDevices] = useState(null); // null = using bundledCatalog
  const [dataSource, setDataSource] = useState({ mode: 'bundled', checkedAt: null, error: null });
  const MASTER_DEVICES = liveDevices || bundledCatalog;
  const maxCatalogPrice = useMemo(() => Math.max(...MASTER_DEVICES.map(minPrice)), [MASTER_DEVICES]);

  const [appReady, setAppReady] = useState(false);
  const [initError, setInitError] = useState(false);
  const [theme, setTheme] = useState('dark');
  const [view, setView] = useState('catalog');
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [variantByDevice, setVariantByDevice] = useState({});
  const [wishlist, setWishlist] = useState([]);
  const [compareIds, setCompareIds] = useState([]);
  const [collections, setCollections] = useState([]);
  const [openCollectionId, setOpenCollectionId] = useState(null);

  const [query, setQuery] = useState('');
  const [brand, setBrand] = useState('All');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortKey, setSortKey] = useState('newest');
  const [visibleCount, setVisibleCount] = useState(24);
  const [toast, setToast] = useState(null);
  const [shareTarget, setShareTarget] = useState(null); // { device, url, title } | null — fallback share panel

  const loadedRef = useRef(false);
  const toastTimer = useRef(null);
  const sentinelRef = useRef(null);

  // ---- Startup: prepare essential data + restore persisted user state ----
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        let saved = null;
        if (typeof window !== 'undefined') {
          try {
            const res = await storage.get('xenvia:user-data');
            saved = res ? JSON.parse(res.value) : null;
          } catch (e) { saved = null; }
        }
        if (!cancelled && saved) {
          if (Array.isArray(saved.wishlist)) setWishlist(saved.wishlist);
          if (Array.isArray(saved.compareIds)) setCompareIds(saved.compareIds.slice(0, 3));
          if (Array.isArray(saved.collections)) setCollections(saved.collections);
          if (saved.theme === 'light' || saved.theme === 'dark') setTheme(saved.theme);
        }

        // Live data attempt — only when DEVICE_SOURCE is 'api' (src/lib/api.js).
        // Any failure here (backend down, no network, wrong URL) just leaves
        // liveDevices at null, which means MASTER_DEVICES quietly keeps using
        // the bundled catalogue — the app never shows a blank screen or an
        // error state over this, it just degrades to sample data.
        if (DEVICE_SOURCE === 'api' && !cancelled) {
          try {
            const apiDevices = await fetchDevicesFromApi({ pageSize: 500 });
            if (!cancelled && Array.isArray(apiDevices) && apiDevices.length) {
              setLiveDevices(adaptApiDevices(apiDevices));
              setDataSource({ mode: 'live', checkedAt: new Date().toISOString(), error: null });
            } else if (!cancelled) {
              setDataSource({ mode: 'bundled', checkedAt: new Date().toISOString(), error: 'Backend returned no devices' });
            }
          } catch (e) {
            if (!cancelled) setDataSource({ mode: 'bundled', checkedAt: new Date().toISOString(), error: e.message || 'Backend unreachable' });
          }
        }
      } catch (e) {
        if (!cancelled) setInitError(true);
      } finally {
        if (!cancelled) { loadedRef.current = true; setAppReady(true); }
      }
    }
    init();
    return () => { cancelled = true; };
  }, []);

  // ---- Persist wishlist / compare / collections / theme together ----
  useEffect(() => {
    if (!loadedRef.current || typeof window === 'undefined') return;
    const payload = JSON.stringify({ wishlist, compareIds, collections, theme });
    storage.set('xenvia:user-data', payload).catch(() => {});
  }, [wishlist, compareIds, collections, theme]);

  const showToast = useCallback((message) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // ---- Derived data pipeline: search -> filter -> sort ----
  const searched = useMemo(() => searchDevices(MASTER_DEVICES, query), [MASTER_DEVICES, query]);
  const filtered = useMemo(() => filterDevices(searched, filters, brand), [searched, filters, brand]);
  const resultDevices = useMemo(() => sortDevices(filtered, sortKey), [filtered, sortKey]);
  const visibleDevices = resultDevices.slice(0, visibleCount);
  const brandList = useMemo(() => orderedBrands(MASTER_DEVICES), [MASTER_DEVICES]);
  const activeFilterCount = Object.entries(filters).filter(([k, v]) => v && v !== 'all' && v !== 0).length + (brand !== 'All' ? 1 : 0) + (query ? 1 : 0);

  useEffect(() => { setVisibleCount(24); }, [query, brand, filters, sortKey]);

  useEffect(() => {
    if (!sentinelRef.current || view !== 'catalog') return;
    const el = sentinelRef.current;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisibleCount((c) => Math.min(c + 24, resultDevices.length));
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [view, resultDevices.length]);

  const deviceById = useMemo(() => { const m = new Map(); MASTER_DEVICES.forEach((d) => m.set(d.id, d)); return m; }, [MASTER_DEVICES]);

  function openDevice(id) { setSelectedDeviceId(id); setView('details'); }
  function goBack() { setView('catalog'); }

  function getSelectedVariant(device) {
    const vid = variantByDevice[device.id] || device.defaultVariantId;
    return device.variants.find((v) => v.id === vid) || device.variants[0];
  }
  function selectVariant(device, variantId) { setVariantByDevice((m) => ({ ...m, [device.id]: variantId })); }

  function toggleWishlist(id) {
    setWishlist((w) => {
      const inList = w.includes(id);
      showToast(inList ? 'Removed from wishlist' : 'Added to wishlist');
      return inList ? w.filter((x) => x !== id) : [...w, id];
    });
  }
  function toggleCompare(id) {
    setCompareIds((c) => {
      if (c.includes(id)) return c.filter((x) => x !== id);
      if (c.length >= 3) { showToast('Compare list is full (3 max) — remove one first'); return c; }
      showToast('Added to compare');
      return [...c, id];
    });
  }
  async function shareDevice(device) {
    const url = deviceShareUrl(device);
    const title = `${device.brand} ${device.name}`;
    const touch = isTouchDevice();
    if (touch && typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title, url });
        return; // native OS share sheet handled it
      } catch (e) {
        if (e && e.name === 'AbortError') return; // person cancelled the sheet — not an error
        // otherwise (blocked/unsupported in this context): fall through to the in-app panel below
      }
    }
    if (!touch) {
      const copied = await copyToClipboard(url);
      if (copied) { showToast('Link copied to clipboard'); return; }
    }
    setShareTarget({ device, url, title }); // universal fallback: always works
  }

  function createCollection(name) {
    if (!name.trim()) return;
    const id = `col-${Date.now()}`;
    setCollections((c) => [...c, { id, name: name.trim(), deviceIds: [] }]);
    showToast('Collection created');
  }
  function toggleDeviceInCollection(collectionId, deviceId) {
    setCollections((cs) => cs.map((c) => c.id === collectionId ? { ...c, deviceIds: c.deviceIds.includes(deviceId) ? c.deviceIds.filter((x) => x !== deviceId) : [...c.deviceIds, deviceId] } : c));
  }
  function deleteCollection(id) { setCollections((cs) => cs.filter((c) => c.id !== id)); if (openCollectionId === id) setOpenCollectionId(null); }

  function clearFilters() { setFilters(DEFAULT_FILTERS); setBrand('All'); setQuery(''); }

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
    .xenvia { --bg:#0B0D10; --surface:#14171C; --surface2:#1B1F26; --border:#242A32; --text:#F2F4F7; --text-dim:#98A2B3; --accent:#5B8CFF; --accent-warm:#FFB648; --pos:#4ADE80; --neg:#FB7185; font-family:'Inter',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
    .xenvia[data-theme="light"] { --bg:#F5F6F8; --surface:#FFFFFF; --surface2:#F0F1F4; --border:#E2E5EA; --text:#12151A; --text-dim:#5D6572; }
    .xenvia * { box-sizing:border-box; }
    .xenvia h1,.xenvia h2,.xenvia h3,.xenvia .xv-display { font-family:'Space Grotesk',sans-serif; }
    .xenvia .xv-mono { font-family:'IBM Plex Mono',monospace; }
    .xenvia ::-webkit-scrollbar { width:8px; height:8px; }
    .xenvia ::-webkit-scrollbar-thumb { background:var(--border); border-radius:8px; }
    .xenvia button { font-family:inherit; cursor:pointer; }
    .xenvia input, .xenvia select { font-family:inherit; }
    .xenvia a { color:inherit; }
    .xenvia .xv-scroll-x { overflow-x:auto; scrollbar-width:none; }
    .xenvia .xv-scroll-x::-webkit-scrollbar { display:none; }
    .xenvia .xv-card { background:var(--surface); border:1px solid var(--border); border-radius:14px; transition:border-color .15s ease, transform .15s ease; }
    .xenvia .xv-card:hover { border-color:${'#3A4250'}; }
    .xenvia .xv-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; border-radius:10px; border:1px solid var(--border); background:var(--surface2); color:var(--text); padding:8px 14px; font-size:13px; font-weight:500; }
    .xenvia .xv-btn:hover { border-color:${'#3A4250'}; }
    .xenvia .xv-btn:focus-visible, .xenvia button:focus-visible, .xenvia input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .xenvia .xv-btn-primary { background:var(--accent); border-color:var(--accent); color:#08101F; font-weight:600; }
    .xenvia .xv-btn-icon { width:34px; height:34px; padding:0; border-radius:10px; }
    .xenvia .xv-btn-icon.active { background:var(--accent); border-color:var(--accent); color:#08101F; }
    .xenvia .xv-chip { display:inline-flex; align-items:center; gap:6px; padding:7px 13px; border-radius:999px; border:1px solid var(--border); background:var(--surface); color:var(--text-dim); font-size:13px; white-space:nowrap; }
    .xenvia .xv-chip.active { background:var(--accent); border-color:var(--accent); color:#08101F; font-weight:600; }
    .xenvia .xv-input { width:100%; background:var(--surface2); border:1px solid var(--border); border-radius:10px; padding:9px 12px; color:var(--text); font-size:14px; }
    .xenvia .xv-input::placeholder { color:var(--text-dim); }
    .xenvia .xv-stars { display:inline-flex; gap:1px; align-items:center; }
    .xenvia .xv-gauge-track { height:6px; border-radius:6px; background:var(--surface2); overflow:hidden; margin-top:6px; }
    .xenvia .xv-gauge-fill { height:100%; border-radius:6px; }
    .xenvia .xv-gauge-head { display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; }
    .xenvia .xv-gauge-score { color:var(--text-dim); font-weight:400; margin-left:auto; }
    .xenvia .xv-gauge-compact .xv-gauge-head { font-size:11px; }
    .xenvia .xv-art { display:flex; align-items:center; justify-content:center; border-radius:12px 12px 0 0; }
    .xenvia .xv-art-lg { height:220px; border-radius:16px; }
    .xenvia .xv-art-md { height:150px; }
    .xenvia .xv-art-sm { height:90px; border-radius:10px 10px 0 0; }
    .xenvia .xv-art-frame { width:64%; height:64%; border:1.5px solid; border-radius:20px; display:flex; align-items:center; justify-content:center; }
    .xenvia .xv-spec-row { display:flex; justify-content:space-between; gap:16px; padding:10px 0; border-bottom:1px solid var(--border); font-size:13.5px; }
    .xenvia .xv-spec-row:last-child { border-bottom:none; }
    .xenvia .xv-spec-label { color:var(--text-dim); flex-shrink:0; }
    .xenvia .xv-spec-value { text-align:right; font-family:'IBM Plex Mono',monospace; font-size:13px; }
    .xenvia .xv-tab { display:flex; flex-direction:column; align-items:center; gap:3px; font-size:10.5px; color:var(--text-dim); padding:6px 0; flex:1; position:relative; }
    .xenvia .xv-tab.active { color:var(--accent); }
    .xenvia .xv-badge { position:absolute; top:0; right:22%; background:var(--accent-warm); color:#241800; font-size:9px; font-weight:700; border-radius:999px; min-width:14px; height:14px; display:flex; align-items:center; justify-content:center; padding:0 3px; }
    .xenvia .xv-side-link { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:10px; color:var(--text-dim); font-size:14px; font-weight:500; }
    .xenvia .xv-side-link.active { background:var(--surface2); color:var(--text); }
    .xenvia input[type=range] { -webkit-appearance:none; width:100%; height:4px; background:var(--border); border-radius:4px; }
    .xenvia input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:15px; height:15px; border-radius:50%; background:var(--accent); cursor:pointer; margin-top:-5.5px; }
    @media (prefers-reduced-motion: reduce) { .xenvia * { transition:none !important; animation-duration:.01ms !important; } }
  `;

  if (!appReady) {
    return (
      <div className="xenvia" data-theme={theme} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', flexDirection: 'column', gap: 18 }}>
        <style>{css}</style>
        <div className="xv-display" style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-0.02em' }}>Xenvia</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)', fontSize: 13 }}>
          <Loader2 size={15} className="xv-spin" style={{ animation: 'spin 1s linear infinite' }} />
          <span>Preparing your device library…</span>
        </div>
        <style>{`@keyframes spin { to { transform:rotate(360deg); } }`}</style>
      </div>
    );
  }

  const selectedDevice = selectedDeviceId ? deviceById.get(selectedDeviceId) : null;
  const wishlistDevices = wishlist.map((id) => deviceById.get(id)).filter(Boolean);
  const compareDevices = compareIds.map((id) => deviceById.get(id)).filter(Boolean);
  const openCollection = openCollectionId ? collections.find((c) => c.id === openCollectionId) : null;

  return (
    <div className="xenvia" data-theme={theme} style={{ display: 'flex' }}>
      <style>{css}</style>

      {/* ---------- Desktop sidebar ---------- */}
      <aside className="hidden md:flex" style={{ width: 220, flexShrink: 0, borderRight: '1px solid var(--border)', flexDirection: 'column', padding: 18, position: 'sticky', top: 0, height: '100vh' }}>
        <div className="xv-display" style={{ fontSize: 21, fontWeight: 700, marginBottom: 26, letterSpacing: '-0.02em' }}>Xenvia</div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <NavItem icon={LayoutGrid} label="Catalogue" active={view === 'catalog'} onClick={() => setView('catalog')} />
          <NavItem icon={Heart} label="Wishlist" count={wishlist.length} active={view === 'wishlist'} onClick={() => setView('wishlist')} />
          <NavItem icon={Scale} label="Compare" count={compareIds.length} active={view === 'compare'} onClick={() => setView('compare')} />
          <NavItem icon={Folder} label="Collections" count={collections.length} active={view === 'collections'} onClick={() => setView('collections')} />
          <NavItem icon={SettingsIcon} label="Settings" active={view === 'settings'} onClick={() => setView('settings')} />
        </nav>
        <div style={{ marginTop: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>{MASTER_DEVICES.length} devices · {brandList.length} brands</div>
      </aside>

      {/* ---------- Main content ---------- */}
      <main style={{ flex: 1, minWidth: 0, paddingBottom: 76 }}>
        {/* Mobile top bar */}
        <div className="md:hidden" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 20 }}>
          <div className="xv-display" style={{ fontSize: 19, fontWeight: 700 }}>Xenvia</div>
          <button className="xv-btn xv-btn-icon" onClick={() => setView('settings')} aria-label="Settings"><SettingsIcon size={17} /></button>
        </div>

        {view === 'catalog' && (
          <CatalogView
            devices={visibleDevices} total={resultDevices.length} query={query} setQuery={setQuery}
            brand={brand} setBrand={setBrand} brandList={brandList} filters={filters} setFilters={setFilters}
            filtersOpen={filtersOpen} setFiltersOpen={setFiltersOpen} sortKey={sortKey} setSortKey={setSortKey}
            maxCatalogPrice={maxCatalogPrice} activeFilterCount={activeFilterCount} clearFilters={clearFilters}
            wishlist={wishlist} compareIds={compareIds} onOpen={openDevice} onWishlist={toggleWishlist}
            onCompare={toggleCompare} onShare={shareDevice} getSelectedVariant={getSelectedVariant}
            sentinelRef={sentinelRef}
          />
        )}

        {view === 'details' && selectedDevice && (
          <DeviceDetailsView
            device={selectedDevice} selectedVariant={getSelectedVariant(selectedDevice)} onSelectVariant={selectVariant}
            onBack={goBack} wishlist={wishlist} compareIds={compareIds} onWishlist={toggleWishlist}
            onCompare={toggleCompare} onShare={shareDevice} collections={collections}
            onToggleCollection={toggleDeviceInCollection} onCreateCollection={createCollection}
          />
        )}

        {view === 'wishlist' && (
          <ListView title="Wishlist" subtitle="Devices you're keeping an eye on." devices={wishlistDevices}
            emptyMsg="Nothing saved yet. Tap the heart on any device to add it here."
            wishlist={wishlist} compareIds={compareIds} onOpen={openDevice} onWishlist={toggleWishlist}
            onCompare={toggleCompare} onShare={shareDevice} getSelectedVariant={getSelectedVariant} />
        )}

        {view === 'compare' && (
          <CompareView devices={compareDevices} deviceById={deviceById} getSelectedVariant={getSelectedVariant}
            onSelectVariant={selectVariant} onRemove={toggleCompare} onOpen={openDevice} />
        )}

        {view === 'collections' && !openCollection && (
          <CollectionsView collections={collections} deviceById={deviceById} onCreate={createCollection}
            onOpen={(id) => setOpenCollectionId(id)} onDelete={deleteCollection} />
        )}
        {view === 'collections' && openCollection && (
          <ListView title={openCollection.name} subtitle={`${openCollection.deviceIds.length} device${openCollection.deviceIds.length === 1 ? '' : 's'}`}
            devices={openCollection.deviceIds.map((id) => deviceById.get(id)).filter(Boolean)}
            emptyMsg="No devices in this collection yet." onBack={() => setOpenCollectionId(null)}
            wishlist={wishlist} compareIds={compareIds} onOpen={openDevice} onWishlist={toggleWishlist}
            onCompare={toggleCompare} onShare={shareDevice} getSelectedVariant={getSelectedVariant} />
        )}

        {view === 'settings' && (
          <SettingsView theme={theme} setTheme={setTheme} deviceCount={MASTER_DEVICES.length} brandCount={brandList.length} dataSource={dataSource} />
        )}
      </main>

      {/* ---------- Mobile bottom tab bar ---------- */}
      <nav className="flex md:hidden" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--surface)', borderTop: '1px solid var(--border)', padding: '8px 4px', zIndex: 30 }}>
        <TabItem icon={LayoutGrid} label="Catalogue" active={view === 'catalog'} onClick={() => setView('catalog')} />
        <TabItem icon={Heart} label="Wishlist" count={wishlist.length} active={view === 'wishlist'} onClick={() => setView('wishlist')} />
        <TabItem icon={Scale} label="Compare" count={compareIds.length} active={view === 'compare'} onClick={() => setView('compare')} />
        <TabItem icon={Folder} label="Collections" count={collections.length} active={view === 'collections'} onClick={() => setView('collections')} />
      </nav>

      {toast && (
        <div style={{ position: 'fixed', bottom: 84, left: '50%', transform: 'translateX(-50%)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 16px', fontSize: 13, zIndex: 50, boxShadow: '0 8px 24px rgba(0,0,0,.3)' }}>
          {toast}
        </div>
      )}

      {shareTarget && (
        <SharePanel target={shareTarget} onClose={() => setShareTarget(null)} onCopy={async () => { const ok = await copyToClipboard(shareTarget.url); showToast(ok ? 'Link copied to clipboard' : 'Could not copy automatically — select the link above and copy it'); }} />
      )}
    </div>
  );
}

function SharePanel({ target, onClose, onCopy }) {
  const { url, title } = target;
  const encodedTitleUrl = encodeURIComponent(`${title} — ${url}`);
  const targets = [
    { label: 'WhatsApp', icon: MessageCircle, href: `https://wa.me/?text=${encodedTitleUrl}` },
    { label: 'Messages (SMS)', icon: MessageSquare, href: `sms:?&body=${encodedTitleUrl}` },
    { label: 'Email', icon: Mail, href: `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}` },
    { label: 'Telegram', icon: Send, href: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}` },
    { label: 'X (Twitter)', icon: AtSign, href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}` },
    { label: 'Facebook', icon: Globe, href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` },
  ];
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div className="xv-card" style={{ width: '100%', maxWidth: 380, padding: 18 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 14.5 }}>Share {title}</div>
          <button className="xv-btn xv-btn-icon" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          <input className="xv-input" readOnly value={url} onFocus={(e) => e.target.select()} style={{ fontSize: 12 }} />
          <button className="xv-btn xv-btn-primary" onClick={onCopy}><Copy size={13} /> Copy</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {targets.map((t) => (
            <a key={t.label} href={t.href} target="_blank" rel="noopener noreferrer" className="xv-btn" style={{ flexDirection: 'column', gap: 5, padding: '12px 6px', textDecoration: 'none' }}>
              <t.icon size={17} />
              <span style={{ fontSize: 10.5, textAlign: 'center' }}>{t.label}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function NavItem({ icon: Icon, label, active, onClick, count }) {
  return (
    <button className={`xv-side-link ${active ? 'active' : ''}`} onClick={onClick} style={{ background: 'none', border: 'none', textAlign: 'left', width: '100%' }}>
      <Icon size={17} />
      <span style={{ flex: 1 }}>{label}</span>
      {!!count && <span style={{ fontSize: 11, color: 'var(--text-dim)' }} className="xv-mono">{count}</span>}
    </button>
  );
}

function TabItem({ icon: Icon, label, active, onClick, count }) {
  return (
    <button className={`xv-tab ${active ? 'active' : ''}`} onClick={onClick} style={{ background: 'none', border: 'none' }}>
      <span style={{ position: 'relative' }}>
        <Icon size={19} />
        {!!count && <span className="xv-badge">{count}</span>}
      </span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Device Card
// ---------------------------------------------------------------------------
function DeviceCard({ device, wishlist, compareIds, onOpen, onWishlist, onCompare, onShare, getSelectedVariant }) {
  const variant = getSelectedVariant(device);
  const isWished = wishlist.includes(device.id);
  const isCompared = compareIds.includes(device.id);
  return (
    <div className="xv-card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <button onClick={() => onOpen(device.id)} style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', display: 'block', width: '100%' }}>
        <DeviceArt device={device} size="md" />
      </button>
      <div style={{ padding: 13, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        <button onClick={() => onOpen(device.id)} style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left' }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 2 }}>{device.brand}</div>
          <div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.3 }}>{device.name}</div>
        </button>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }} className="xv-mono">{variant.ram}GB / {variant.rom}GB</div>
        <div style={{ fontSize: 16, fontWeight: 700 }} className="xv-mono">{formatPKR(resolvePrice(variant))}</div>
        <div className="xv-scroll-x" style={{ display: 'flex', gap: 6 }}>
          <span className="xv-chip" style={{ padding: '4px 9px', fontSize: 11 }}>{device.display.refresh}Hz</span>
          <span className="xv-chip" style={{ padding: '4px 9px', fontSize: 11 }}>{(device.battery / 1000).toFixed(1)}k mAh</span>
          {deriveChargingProtocolLabel(device) && <span className="xv-chip" style={{ padding: '4px 9px', fontSize: 11 }}>{deriveChargingProtocolLabel(device)}</span>}
          <span className="xv-chip" style={{ padding: '4px 9px', fontSize: 11 }}>{device.network}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <StarRow rating={device.rating} />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{device.rating.toFixed(1)}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 4 }}>
          <button className={`xv-btn xv-btn-icon ${isWished ? 'active' : ''}`} onClick={() => onWishlist(device.id)} aria-label="Wishlist" title="Wishlist">
            <Heart size={15} style={{ fill: isWished ? '#08101F' : 'none' }} />
          </button>
          <button className={`xv-btn xv-btn-icon ${isCompared ? 'active' : ''}`} onClick={() => onCompare(device.id)} aria-label="Compare" title="Compare">
            <Scale size={15} />
          </button>
          <button className="xv-btn xv-btn-icon" onClick={() => onShare(device)} aria-label="Share" title="Share">
            <Share2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Catalog view
// ---------------------------------------------------------------------------
function CatalogView({ devices, total, query, setQuery, brand, setBrand, brandList, filters, setFilters, filtersOpen, setFiltersOpen, sortKey, setSortKey, maxCatalogPrice, activeFilterCount, clearFilters, wishlist, compareIds, onOpen, onWishlist, onCompare, onShare, getSelectedVariant, sentinelRef }) {
  return (
    <div style={{ padding: '18px 20px 8px' }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 240px' }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-dim)' }} />
          <input className="xv-input" style={{ paddingLeft: 32 }} placeholder="Search brand, model, or model number"
            value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className="xv-input" style={{ width: 160 }} value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="price-asc">Price: low to high</option>
          <option value="price-desc">Price: high to low</option>
          <option value="rating">Highest rated</option>
        </select>
        <button className="xv-btn" onClick={() => setFiltersOpen((o) => !o)}>
          <SlidersHorizontal size={14} /> Filters {activeFilterCount > 0 && <span className="xv-mono">({activeFilterCount})</span>}
        </button>
      </div>

      <div className="xv-scroll-x" style={{ display: 'flex', gap: 7, marginBottom: 14, paddingBottom: 2 }}>
        <button className={`xv-chip ${brand === 'All' ? 'active' : ''}`} onClick={() => setBrand('All')}>All brands</button>
        {brandList.map(({ brand: b, count }) => (
          <button key={b} className={`xv-chip ${brand === b ? 'active' : ''}`} onClick={() => setBrand(b)}>{b} <span className="xv-mono" style={{ opacity: .7 }}>{count}</span></button>
        ))}
      </div>

      {filtersOpen && (
        <FilterPanel filters={filters} setFilters={setFilters} maxCatalogPrice={maxCatalogPrice} onClear={clearFilters} onClose={() => setFiltersOpen(false)} />
      )}

      <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>{total} device{total === 1 ? '' : 's'} found</span>
        {filters.yearMin > 0 && (
          <>
            <span>· showing {filters.yearMin}–{new Date().getFullYear()}</span>
            <button className="xv-btn" style={{ padding: '3px 9px', fontSize: 11.5 }} onClick={() => setFilters((f) => ({ ...f, yearMin: 0 }))}>Show older devices too</button>
          </>
        )}
      </div>

      {devices.length === 0 ? (
        <EmptyState title="No devices match those filters" subtitle="Try widening your search or clearing a few filters." action={<button className="xv-btn xv-btn-primary" onClick={clearFilters}><RotateCcw size={14} /> Clear filters</button>} />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }} className="xv-grid">
            {devices.map((d) => (
              <DeviceCard key={d.id} device={d} wishlist={wishlist} compareIds={compareIds} onOpen={onOpen} onWishlist={onWishlist} onCompare={onCompare} onShare={onShare} getSelectedVariant={getSelectedVariant} />
            ))}
          </div>
          {devices.length < total && <div ref={sentinelRef} style={{ height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>Loading more…</div>}
          <style>{`@media (min-width:640px){ .xv-grid{ grid-template-columns:repeat(3,1fr) !important; } } @media (min-width:1024px){ .xv-grid{ grid-template-columns:repeat(4,1fr) !important; } } @media (min-width:1400px){ .xv-grid{ grid-template-columns:repeat(5,1fr) !important; } }`}</style>
        </>
      )}
    </div>
  );
}

function FilterPanel({ filters, setFilters, maxCatalogPrice, onClear, onClose }) {
  function set(key, value) { setFilters((f) => ({ ...f, [key]: value })); }
  return (
    <div className="xv-card" style={{ padding: 16, marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16 }}>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>Category</label>
        <select className="xv-input" style={{ marginTop: 6 }} value={filters.category} onChange={(e) => set('category', e.target.value)}>
          <option value="all">All categories</option>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>Max price: {filters.priceMax ? formatPKR(filters.priceMax) : 'Any'}</label>
        <input type="range" min={0} max={maxCatalogPrice} step={10000} value={filters.priceMax || 0} onChange={(e) => set('priceMax', Number(e.target.value))} style={{ marginTop: 12 }} />
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>Min RAM</label>
        <select className="xv-input" style={{ marginTop: 6 }} value={filters.ram} onChange={(e) => set('ram', Number(e.target.value))}>
          <option value={0}>Any</option>
          {[4, 6, 8, 12, 16].map((r) => <option key={r} value={r}>{r}GB+</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>Min storage</label>
        <select className="xv-input" style={{ marginTop: 6 }} value={filters.rom} onChange={(e) => set('rom', Number(e.target.value))}>
          <option value={0}>Any</option>
          {[64, 128, 256, 512, 1024].map((r) => <option key={r} value={r}>{r}GB+</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>Chipset family</label>
        <select className="xv-input" style={{ marginTop: 6 }} value={filters.chipFamily} onChange={(e) => set('chipFamily', e.target.value)}>
          <option value="all">Any chipset</option>
          <option value="snapdragon">Snapdragon</option>
          <option value="dimensity">Dimensity</option>
          <option value="helio">Helio</option>
          <option value="apple">Apple</option>
          <option value="exynos">Exynos</option>
          <option value="tensor">Tensor</option>
          <option value="kirin">Kirin</option>
          <option value="unisoc">Unisoc</option>
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>Min battery</label>
        <select className="xv-input" style={{ marginTop: 6 }} value={filters.battMin} onChange={(e) => set('battMin', Number(e.target.value))}>
          <option value={0}>Any</option>
          {[4000, 4500, 5000, 6000].map((b) => <option key={b} value={b}>{b}+ mAh</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>Network</label>
        <select className="xv-input" style={{ marginTop: 6 }} value={filters.network} onChange={(e) => set('network', e.target.value)}>
          <option value="all">4G or 5G</option>
          <option value="5G">5G only</option>
          <option value="4G">4G only</option>
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>Operating system</label>
        <select className="xv-input" style={{ marginTop: 6 }} value={filters.os} onChange={(e) => set('os', e.target.value)}>
          <option value="all">Any OS</option>
          <option value="ios">iOS</option>
          <option value="android">Android</option>
          <option value="harmonyos">HarmonyOS</option>
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>Released after</label>
        <select className="xv-input" style={{ marginTop: 6 }} value={filters.yearMin} onChange={(e) => set('yearMin', Number(e.target.value))}>
          <option value={0}>Any year (include older devices)</option>
          {Array.from({ length: 7 }, (_, i) => new Date().getFullYear() - i).map((y) => <option key={y} value={y}>{y}+ {y === catalogWindowFloorYear() ? `(last ${CATALOG_WINDOW_YEARS} yrs)` : ''}</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>Gaming capability</label>
        <select className="xv-input" style={{ marginTop: 6 }} value={filters.gaming} onChange={(e) => set('gaming', e.target.value)}>
          <option value="all">Any</option>
          {Object.keys(GAMING_COLORS).map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <button className="xv-btn" onClick={onClear}><RotateCcw size={13} /> Clear all</button>
        <button className="xv-btn" onClick={onClose}><X size={13} /> Close</button>
      </div>
    </div>
  );
}

function EmptyState({ title, subtitle, action }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-dim)' }}>
      <Info size={26} style={{ marginBottom: 10, opacity: .6 }} />
      <div style={{ fontSize: 15, color: 'var(--text)', fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, marginBottom: 16 }}>{subtitle}</div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable list view (wishlist / collection contents)
// ---------------------------------------------------------------------------
function ListView({ title, subtitle, devices, emptyMsg, onBack, wishlist, compareIds, onOpen, onWishlist, onCompare, onShare, getSelectedVariant }) {
  return (
    <div style={{ padding: '18px 20px' }}>
      {onBack && <button className="xv-btn" style={{ marginBottom: 14 }} onClick={onBack}><ArrowLeft size={14} /> Back</button>}
      <div className="xv-display" style={{ fontSize: 22, fontWeight: 700, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 18 }}>{subtitle}</div>
      {devices.length === 0 ? (
        <EmptyState title="Nothing here yet" subtitle={emptyMsg} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }} className="xv-grid">
          {devices.map((d) => (
            <DeviceCard key={d.id} device={d} wishlist={wishlist} compareIds={compareIds} onOpen={onOpen} onWishlist={onWishlist} onCompare={onCompare} onShare={onShare} getSelectedVariant={getSelectedVariant} />
          ))}
          <style>{`@media (min-width:640px){ .xv-grid{ grid-template-columns:repeat(3,1fr) !important; } } @media (min-width:1024px){ .xv-grid{ grid-template-columns:repeat(4,1fr) !important; } }`}</style>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Device details
// ---------------------------------------------------------------------------
function DeviceDetailsView({ device, selectedVariant, onSelectVariant, onBack, wishlist, compareIds, onWishlist, onCompare, onShare, collections, onToggleCollection, onCreateCollection }) {
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [specMode, setSpecMode] = useState('basic'); // 'basic' | 'detailed' — toggle below the gaming card
  const isWished = wishlist.includes(device.id);
  const isCompared = compareIds.includes(device.id);
  const price = resolvePrice(selectedVariant);

  return (
    <div style={{ padding: '18px 20px 40px', maxWidth: 880, margin: '0 auto' }}>
      <button className="xv-btn" style={{ marginBottom: 14 }} onClick={onBack}><ArrowLeft size={14} /> Back to catalogue</button>

      <div className="xv-card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ flex: '0 0 220px' }}><DeviceArt device={device} size="lg" /></div>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{device.brand} · {device.modelNumber}</div>
            <h1 className="xv-display" style={{ fontSize: 24, fontWeight: 700, margin: '4px 0 8px', lineHeight: 1.25 }}>{device.name}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <StarRow rating={device.rating} size={15} />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{device.rating.toFixed(1)} · {device.reviewCount.toLocaleString()} reviews</span>
            </div>
            <span className="xv-chip" style={{ marginRight: 6 }}>{CATEGORY_LABELS[device.category]}</span>
            <span className="xv-chip">{device.releaseYear}</span>

            {getSpecialty(device) && (
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5 }}>
                <Sparkles size={12} style={{ color: 'var(--accent-warm)', marginRight: 5, verticalAlign: -1 }} />
                {getSpecialty(device)}
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>Variant</div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                {device.variants.map((v) => (
                  <button key={v.id} className={`xv-chip ${v.id === selectedVariant.id ? 'active' : ''}`} onClick={() => onSelectVariant(device, v.id)}>
                    {v.ram}GB / {v.rom}GB
                  </button>
                ))}
              </div>
              {device.colors && device.colors.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {device.colors.map((c) => <span key={c} className="xv-chip" style={{ fontSize: 11, padding: '4px 9px' }}>{c}</span>)}
                </div>
              )}
            </div>

            <div style={{ marginTop: 16, display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span className="xv-mono" style={{ fontSize: 26, fontWeight: 700 }}>{formatPKR(price)}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>avg. market price · priceoye.pk priority</span>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button className={`xv-btn ${isWished ? 'xv-btn-primary' : ''}`} onClick={() => onWishlist(device.id)}><Heart size={14} style={{ fill: isWished ? '#08101F' : 'none' }} /> {isWished ? 'Wishlisted' : 'Wishlist'}</button>
              <button className={`xv-btn ${isCompared ? 'xv-btn-primary' : ''}`} onClick={() => onCompare(device.id)}><Scale size={14} /> {isCompared ? 'In compare' : 'Compare'}</button>
              <button className="xv-btn" onClick={() => onShare(device)}><Share2 size={14} /> Share</button>
              <div style={{ position: 'relative' }}>
                <button className="xv-btn" onClick={() => setColMenuOpen((o) => !o)}><FolderPlus size={14} /> Collection</button>
                {colMenuOpen && (
                  <div className="xv-card" style={{ position: 'absolute', top: 40, right: 0, width: 220, padding: 10, zIndex: 10 }}>
                    {collections.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>No collections yet.</div>}
                    {collections.map((c) => (
                      <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: 13, cursor: 'pointer' }}>
                        <input type="checkbox" checked={c.deviceIds.includes(device.id)} onChange={() => onToggleCollection(c.id, device.id)} />
                        {c.name}
                      </label>
                    ))}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <input className="xv-input" style={{ fontSize: 12, padding: '6px 8px' }} placeholder="New collection" value={newColName} onChange={(e) => setNewColName(e.target.value)} />
                      <button className="xv-btn xv-btn-icon" onClick={() => { onCreateCollection(newColName); setNewColName(''); }}><Plus size={14} /></button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="xv-card" style={{ padding: 18, marginBottom: 16 }}>
        <GamingGauge gaming={device.gaming} />
        {gamingRationale(device) && <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 10, lineHeight: 1.5 }}>{gamingRationale(device)}</div>}
        {specMode === 'detailed' && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>How the score is reached</div>
            {[['Chipset tier', device.gaming.breakdown.chipset, 100], ['Memory (top variant)', device.gaming.breakdown.memory, 100], ['High refresh rate bonus', device.gaming.breakdown.refreshBonus, 6], ['Battery headroom bonus', device.gaming.breakdown.batteryBonus, 4], ['Gaming-category bonus', device.gaming.breakdown.categoryBonus, 6]].map(([label, val, max]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-dim)', padding: '3px 0' }}>
                <span>{label}</span><span className="xv-mono">{val}/{max}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 7, marginBottom: 4 }}>
        <button className={`xv-chip ${specMode === 'basic' ? 'active' : ''}`} onClick={() => setSpecMode('basic')}>Basic specs</button>
        <button className={`xv-chip ${specMode === 'detailed' ? 'active' : ''}`} onClick={() => setSpecMode('detailed')}>Detailed specs</button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dim)', margin: '6px 0 14px' }}>
        {specMode === 'basic' ? 'Key specs at a glance.' : 'Every recorded spec, plus figures computed or derived from them (pixel density, processor core layout, connectivity profile). Derived fields are typical for this chipset/tier rather than a confirmed unit-by-unit spec sheet — noted inline where that matters.'}
      </div>

      {specMode === 'basic' ? (
        <>
          <SpecSection title="Display" icon={LayoutGrid} rows={[
            ['Size', `${device.display.size}"`], ['Type', device.display.type], ['Refresh rate', `${device.display.refresh}Hz`],
          ]} />
          <SpecSection title="Performance" icon={Cpu} rows={[
            ['Chipset', device.chipset], ['RAM', `${selectedVariant.ram}GB`], ['Storage', `${selectedVariant.rom}GB`],
          ]} />
          <SpecSection title="Camera" icon={Camera} rows={[
            ['Main', `${device.camera.main}MP`], ['Front', `${device.camera.front}MP`],
          ]} />
          <SpecSection title="Battery" icon={BatteryCharging} rows={[
            ['Capacity', `${device.battery} mAh`], ['Charging', `${device.charging}W`],
          ]} />
          <SpecSection title="Network & OS" icon={Wifi} rows={[
            ['Network', device.network], ['OS', device.os],
          ]} />
        </>
      ) : (() => {
        const proc = deriveProcessorDetail(device.chipset);
        const cam = deriveCameraDetail(device);
        const batt = deriveBatteryDetail(device);
        const conn = deriveConnectivity(device);
        return (
          <>
            <SpecSection title="Display" icon={LayoutGrid} rows={[
              ['Size', `${device.display.size}"`], ['Type', device.display.type], ['Refresh rate', `${device.display.refresh}Hz`], ['Resolution', device.display.resolution],
              ['Pixel density', pixelDensity(device) ? `${pixelDensity(device)} ppi` : '—'], ['Aspect ratio', aspectRatio(device) || '—'],
            ]} />
            <SpecSection title="Performance" icon={Cpu} rows={[
              ['Chipset', device.chipset], ['GPU', device.gpu], ['CPU cores', proc.cores], ['Clock speed', proc.clock], ['RAM', `${selectedVariant.ram}GB`], ['Storage', `${selectedVariant.rom}GB`],
            ]} />
            <SpecSection title="Camera" icon={Camera} rows={[
              ['Main', `${device.camera.main}MP, ${cam.main.aperture}`], ['Main — OIS', cam.main.ois], ['Main — video', cam.main.video],
              ...(cam.ultrawide ? [['Ultrawide', `${device.camera.ultrawide}MP, ${cam.ultrawide.aperture}`]] : []),
              ...(cam.telephoto ? [['Telephoto', `${device.camera.telephoto}MP, ${cam.telephoto.aperture}`], ['Telephoto — zoom', cam.telephoto.zoom]] : []),
              ['Front', `${device.camera.front}MP, ${cam.front.aperture}`], ['Front — video', cam.front.video],
              ['Rear camera count', String(1 + (device.camera.ultrawide ? 1 : 0) + (device.camera.telephoto ? 1 : 0))],
            ]} />
            <SpecSection title="Battery & charging" icon={BatteryCharging} rows={[
              ['Capacity', `${device.battery} mAh`], ['Type', batt.type], ['Wired charging', `${device.charging}W`], ['Fast-charge protocol', deriveChargingProtocolLabel(device) || batt.fastChargeTech],
              ['Wireless charging', batt.wireless], ['Reverse wireless charging', batt.reverseWireless],
            ]} />
            <SpecSection title="SIM & bands" icon={Wifi} rows={[
              ['SIM support', deriveSimInfo(device)], ['Network generations', deriveNetworkBands(device)],
              ['Frequency bands', 'Varies by regional/carrier variant — check with your carrier for exact 2G/3G/4G/5G band support'],
            ]} />
            <SpecSection title="Connectivity" icon={Wifi} rows={[
              ['Network', device.network], ['Wi-Fi', conn.wifi], ['Bluetooth', conn.bluetooth], ['NFC', conn.nfc], ['GPS / GNSS', conn.gps], ['USB', conn.usb], ['Operating system', device.os],
            ]} />
            <SpecSection title="Build" icon={Smartphone} rows={[
              ['Weight', `${device.weight}g`], ['Dimensions', device.dimensions], ['Release year', String(device.releaseYear)], ['Category', CATEGORY_LABELS[device.category]], ['Model number', device.modelNumber],
            ]} />
            <SpecSection title="All variants & pricing" icon={Layers} rows={device.variants.map((v) => [`${v.ram}GB / ${v.rom}GB`, formatPKR(resolvePrice(v)) + (v.id === selectedVariant.id ? ' · selected' : '')])} />
          </>
        );
      })()}
    </div>
  );
}

function SpecSection({ title, icon: Icon, rows }) {
  return (
    <div className="xv-card" style={{ padding: 18, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontWeight: 600, fontSize: 14 }}>
        <Icon size={15} style={{ color: 'var(--accent)' }} /> {title}
      </div>
      {rows.map(([label, value]) => (
        <div className="xv-spec-row" key={label}>
          <span className="xv-spec-label">{label}</span>
          <span className="xv-spec-value">{value}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compare view
// ---------------------------------------------------------------------------
const COMPARE_ROWS = [
  { label: 'Price', get: (d, v) => resolvePrice(v), fmt: (n) => formatPKR(n), higherBetter: false },
  { label: 'Display', get: (d) => `${d.display.size}" · ${d.display.refresh}Hz`, fmt: (v) => v },
  { label: 'Chipset', get: (d) => d.chipset, fmt: (v) => v },
  { label: 'RAM', get: (d, v) => v.ram, fmt: (n) => `${n}GB`, higherBetter: true },
  { label: 'Storage', get: (d, v) => v.rom, fmt: (n) => `${n}GB`, higherBetter: true },
  { label: 'Main camera', get: (d) => d.camera.main, fmt: (n) => `${n}MP`, higherBetter: true },
  { label: 'Battery', get: (d) => d.battery, fmt: (n) => `${n} mAh`, higherBetter: true },
  { label: 'Charging', get: (d) => d.charging, fmt: (n) => `${n}W`, higherBetter: true },
  { label: 'Gaming score', get: (d) => d.gaming.score, fmt: (n, d) => `${d.gaming.label} (${n}/100)`, higherBetter: true },
  { label: 'Rating', get: (d) => d.rating, fmt: (n) => `${n.toFixed(1)} / 5`, higherBetter: true },
  { label: 'Network', get: (d) => d.network, fmt: (v) => v },
  { label: 'OS', get: (d) => d.os, fmt: (v) => v },
  { label: 'Weight', get: (d) => d.weight, fmt: (n) => `${n}g`, higherBetter: false },
];

function CompareView({ devices, getSelectedVariant, onSelectVariant, onRemove, onOpen }) {
  if (devices.length === 0) {
    return <div style={{ padding: '18px 20px' }}><EmptyState title="No devices to compare" subtitle="Add up to 3 devices from the catalogue using the compare icon." /></div>;
  }
  const variants = devices.map((d) => getSelectedVariant(d));

  function bestIndex(row) {
    if (row.higherBetter === undefined) return -1;
    const values = devices.map((d, i) => Number(row.get(d, variants[i])));
    if (values.some((v) => Number.isNaN(v))) return -1;
    const target = row.higherBetter ? Math.max(...values) : Math.min(...values);
    return values.indexOf(target);
  }

  return (
    <div style={{ padding: '18px 20px 40px' }}>
      <div className="xv-display" style={{ fontSize: 22, fontWeight: 700, marginBottom: 2 }}>Compare</div>
      <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 18 }}>{devices.length} of 3 devices selected</div>

      {/* Side-by-side comparison table — used at every screen size. Label
          column stays pinned on the left while device columns scroll
          together horizontally, so devices are always compared column by
          column (never one full device stacked above the next). */}
      <div className="xv-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `92px repeat(${devices.length}, minmax(126px, 1fr))`, minWidth: 92 + devices.length * 126, borderBottom: '1px solid var(--border)' }}>
            <div style={{ position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 2 }} />
            {devices.map((d, i) => (
              <div key={d.id} style={{ padding: '10px 8px', borderLeft: '1px solid var(--border)' }}>
                <button onClick={() => onOpen(d.id)} style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0, width: '100%' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{d.brand}</div>
                  <div style={{ fontWeight: 600, fontSize: 12, lineHeight: 1.25 }}>{d.name}</div>
                </button>
                <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                  {d.variants.map((v) => (
                    <button key={v.id} className={`xv-chip ${v.id === variants[i].id ? 'active' : ''}`} style={{ fontSize: 9.5, padding: '2px 6px' }} onClick={() => onSelectVariant(d, v.id)}>{v.ram}/{v.rom}</button>
                  ))}
                </div>
                <button className="xv-btn xv-btn-icon" style={{ marginTop: 6, width: 26, height: 26 }} onClick={() => onRemove(d.id)} aria-label="Remove"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
          {COMPARE_ROWS.map((row) => {
            const best = bestIndex(row);
            return (
              <div key={row.label} style={{ display: 'grid', gridTemplateColumns: `92px repeat(${devices.length}, minmax(126px, 1fr))`, borderBottom: '1px solid var(--border)' }}>
                <div style={{ position: 'sticky', left: 0, background: 'var(--surface)', padding: '10px 8px', color: 'var(--text-dim)', fontSize: 11, zIndex: 1 }}>{row.label}</div>
                {devices.map((d, i) => {
                  const raw = row.get(d, variants[i]);
                  return (
                    <div key={d.id} style={{ padding: '10px 8px', borderLeft: '1px solid var(--border)', fontSize: 11.5 }} className="xv-mono">
                      <span style={i === best ? { color: 'var(--pos)', fontWeight: 700 } : {}}>{row.fmt(raw, d)}</span>
                      {i === best && <Check size={10} style={{ marginLeft: 3, color: 'var(--pos)' }} />}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {devices.length > 1 && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>Swipe/scroll sideways to see all {devices.length} devices if they don't all fit on screen at once.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------
function CollectionsView({ collections, deviceById, onCreate, onOpen, onDelete }) {
  const [name, setName] = useState('');
  return (
    <div style={{ padding: '18px 20px 40px' }}>
      <div className="xv-display" style={{ fontSize: 22, fontWeight: 700, marginBottom: 2 }}>Collections</div>
      <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 18 }}>Group devices however you like — comparisons for later, or just favourites by theme.</div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, maxWidth: 360 }}>
        <input className="xv-input" placeholder="New collection name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="xv-btn xv-btn-primary" onClick={() => { onCreate(name); setName(''); }}><Plus size={14} /> Create</button>
      </div>

      {collections.length === 0 ? (
        <EmptyState title="No collections yet" subtitle="Create one above, then add devices to it from any device page." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {collections.map((c) => (
            <div key={c.id} className="xv-card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <button onClick={() => onOpen(c.id)} style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>{c.deviceIds.length} device{c.deviceIds.length === 1 ? '' : 's'}</div>
                </button>
                <button className="xv-btn xv-btn-icon" onClick={() => onDelete(c.id)}><Trash2 size={13} /></button>
              </div>
              {c.deviceIds.length > 0 && (
                <div style={{ display: 'flex', gap: -6, marginTop: 12 }}>
                  {c.deviceIds.slice(0, 4).map((id) => {
                    const d = deviceById.get(id); if (!d) return null;
                    return <div key={id} style={{ width: 26, height: 26, borderRadius: 8, background: `${d.accent}33`, border: `1px solid ${d.accent}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginLeft: -6 }}><Smartphone size={12} style={{ color: d.accent }} /></div>;
                  })}
                </div>
              )}
              <button className="xv-btn" style={{ marginTop: 12, width: '100%', justifyContent: 'center' }} onClick={() => onOpen(c.id)}>Open <ChevronRight size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function SettingsView({ theme, setTheme, deviceCount, brandCount, dataSource }) {
  return (
    <div style={{ padding: '18px 20px 40px', maxWidth: 560 }}>
      <div className="xv-display" style={{ fontSize: 22, fontWeight: 700, marginBottom: 18 }}>Settings</div>

      <div className="xv-card" style={{ padding: 16, marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Appearance</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>Dark is the default; switch anytime.</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className={`xv-btn xv-btn-icon ${theme === 'dark' ? 'active' : ''}`} onClick={() => setTheme('dark')} aria-label="Dark theme"><Moon size={15} /></button>
          <button className={`xv-btn xv-btn-icon ${theme === 'light' ? 'active' : ''}`} onClick={() => setTheme('light')} aria-label="Light theme"><Sun size={15} /></button>
        </div>
      </div>

      <div className="xv-card" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14 }}><Sparkles size={15} style={{ color: 'var(--text-dim)' }} /> AI features</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.5 }}>
          AI-powered chat and smart recommendations are coming soon — the app works fully without them for now.
        </div>
        <div style={{ marginTop: 10 }}><span className="xv-chip">Disabled</span></div>
      </div>

      <div className="xv-card" style={{ padding: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>About</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          {deviceCount} devices across {brandCount} brands. Pricing is informational only — Xenvia is a research and discovery tool, not a store. Your wishlist and collections are saved to this device only.
        </div>
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-dim)' }}>
          Data: <span className="xv-chip" style={{ padding: '2px 8px', fontSize: 10.5 }}>{dataSource.mode === 'live' ? 'Live' : 'Sample'}</span>
        </div>
      </div>
    </div>
  );
}
