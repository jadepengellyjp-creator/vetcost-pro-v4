import { useState, useCallback, useMemo } from "react";

// ── Constants ─────────────────────────────────────────────────────────────────
const GST = 1.15;
const MARKUP = 1.1;
const DEAD_SPACE = 0.005;
const CONSUMABLES = {
  1: { cost: 15.62, sell: 24.99, label: "Level 1" },
  2: { cost: 22.93, sell: 36.68, label: "Level 2" },
  3: { cost: 33.12, sell: 53.00, label: "Level 3" }
};

// ── Formatting helpers ────────────────────────────────────────────────────────
const fmt = v => "$" + (Math.round(v * 100) / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtI = v => Math.round(v).toLocaleString("en-NZ");
const fmtK = v => {
  if (Math.abs(v) >= 1000000) return "$" + (v / 1000000).toFixed(2) + "m";
  return "$" + Math.round(v).toLocaleString("en-NZ");
};

// ── Calculation functions ─────────────────────────────────────────────────────
function calcDrugCost(drug, weight) {
  const doseMg = drug.dose * weight;
  const volMl = doseMg / drug.conc;
  const costPerMl = drug.bottleCost / drug.bottleSize;
  const draws = Math.max(1, Math.ceil(volMl / drug.bottleSize * 10));
  const cost = (volMl + draws * DEAD_SPACE) * costPerMl;
  return { doseMg, volMl, draws, cost, sell: cost * 1.6, deadCost: draws * DEAD_SPACE * costPerMl };
}

function calcAnnualRepay(price, ratePct, years) {
  if (!ratePct || ratePct === 0) return price / years;
  const r = ratePct / 100 / 12;
  const n = years * 12;
  return (price * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1)) * 12;
}

// Time-based overhead allocation: weight OH by total staff-time across all services
function calcProcCost(p, wages, ohPerEvent, isoPerMin, allProcs, allConsults, ohMode) {
  const vetCost = wages.vet * (p.vetMins || 0) / 60;
  const nurseCost = wages.nurse * (p.nurseMins || 0) / 60;
  const vet2Cost = wages.vet * (p.vet2Mins || 0) / 60;
  const hospCost = wages.nurse * (p.hospMins || 0) / 60;
  const postOpCost = wages.nurse * (p.postOpMins || 0) / 60;
  const isoCost = isoPerMin * (p.isoMins || 0);
  const drugCost = (p.drugs || []).reduce((a, d) => a + d.cost, 0);
  const consumCost = CONSUMABLES[p.consumLevel]?.cost || 0;
  const consumSell = CONSUMABLES[p.consumLevel]?.sell || 0;

  let ohAlloc = ohPerEvent;
  if (ohMode === "time" && allProcs && allConsults) {
    const thisMins = (p.vetMins || 0) + (p.nurseMins || 0) + (p.vet2Mins || 0);
    const allItems = [...allProcs, ...allConsults];
    const totalWeightedMins = allItems.reduce((a, s) => {
      const vols = s.vol || 0;
      const mins = (s.vetMins || 0) + (s.nurseMins || 0) + (s.vet2Mins || 0);
      return a + vols * mins;
    }, 0);
    ohAlloc = totalWeightedMins > 0 ? ohPerEvent * (p.vol || 1) * thisMins / totalWeightedMins * (allItems.reduce((a, s) => a + (s.vol || 0), 0) / (p.vol || 1)) : ohPerEvent;
  }

  const totalCostEx = vetCost + nurseCost + vet2Cost + hospCost + postOpCost + isoCost + drugCost + consumCost + ohAlloc;
  const totalSellEx = vetCost * MARKUP + nurseCost * MARKUP + vet2Cost * MARKUP + hospCost * MARKUP + postOpCost * MARKUP + isoCost * MARKUP + drugCost * MARKUP + consumSell + ohAlloc;
  return { vetCost, nurseCost, vet2Cost, hospCost, postOpCost, isoCost, drugCost, consumCost, consumSell, ohAlloc, totalCostEx, totalSellEx, minPriceInc: totalSellEx * GST };
}

function calcConsultCost(c, wages, ohPerEvent, allProcs, allConsults, ohMode) {
  const vetCost = wages.vet * (c.vetMins || 0) / 60;
  const nurseCost = wages.nurse * (c.nurseMins || 0) / 60;
  const supportCost = wages.support * (c.supportMins || 0) / 60;
  const consumSell = CONSUMABLES[c.consumLevel]?.sell || 0;
  const consumCost = CONSUMABLES[c.consumLevel]?.cost || 0;
  const extraCost = (c.extraItems || []).reduce((a, e) => a + e.cost, 0);
  const markup = c.markup || MARKUP;

  let ohAlloc = ohPerEvent;
  if (ohMode === "time" && allProcs && allConsults) {
    const thisMins = (c.vetMins || 0) + (c.nurseMins || 0) + (c.supportMins || 0);
    const allItems = [...allProcs, ...allConsults];
    const totalWeightedMins = allItems.reduce((a, s) => {
      const vols = s.vol || 0;
      const mins = (s.vetMins || 0) + (s.nurseMins || 0) + (s.vet2Mins || 0) + (s.supportMins || 0);
      return a + vols * mins;
    }, 0);
    ohAlloc = totalWeightedMins > 0 ? ohPerEvent * (c.vol || 1) * thisMins / totalWeightedMins * (allItems.reduce((a, s) => a + (s.vol || 0), 0) / (c.vol || 1)) : ohPerEvent;
  }

  const totalCostEx = vetCost + nurseCost + supportCost + consumCost + extraCost + ohAlloc;
  const totalSellEx = (vetCost + nurseCost + supportCost) * markup + consumSell + extraCost * markup + ohAlloc;
  return { vetCost, nurseCost, supportCost, consumCost, consumSell, extraCost, ohAlloc, totalCostEx, totalSellEx, minPriceInc: totalSellEx * GST };
}

// ── Initial data ──────────────────────────────────────────────────────────────
const initialWages = { vet: 75, nurse: 30.5, support: 28, manager: 40, locum: 100 };
const initialIso = { costPerWeek: 189 };
const initialVolumes = { consults: 3000, routine: 500, dental: 120, nurse: 400, nonRoutine: 200 };
const initialOverheads = [
  { label: "Mortgage / lease of building", value: 82500, category: "Premises" },
  { label: "Insurance", value: 22655, category: "Premises" },
  { label: "Repairs & maintenance of building", value: 19006, category: "Premises" },
  { label: "Rates", value: 0, category: "Premises" },
  { label: "Electricity & heating", value: 2475, category: "Premises" },
  { label: "Cleaning & laundry products", value: 229, category: "Premises" },
  { label: "Furniture", value: 500, category: "Premises" },
  { label: "Equipment maintenance (incl autoclave)", value: 868, category: "Equipment" },
  { label: "Instrument hire", value: 74, category: "Equipment" },
  { label: "Software subscriptions", value: 19206, category: "Technology" },
  { label: "Computer & laptop maintenance", value: 4400, category: "Technology" },
  { label: "Website maintenance", value: 532, category: "Technology" },
  { label: "Landline & WiFi", value: 3851, category: "Technology" },
  { label: "Stationery & office supplies", value: 2917, category: "Operations" },
  { label: "Laboratory (IDEXX etc.)", value: 2326, category: "Operations" },
  { label: "Freight & cartage", value: 6874, category: "Operations" },
  { label: "Advertising & marketing", value: 1973, category: "Operations" },
  { label: "Medical waste collection", value: 826, category: "Operations" },
  { label: "General waste collection", value: 395, category: "Operations" },
  { label: "Entertainment & meals", value: 1719, category: "Operations" },
  { label: "Donations & sponsorship", value: 2561, category: "Operations" },
  { label: "Accountant", value: 860, category: "People" },
  { label: "Staff licence fees", value: 2883, category: "People" },
  { label: "Professional memberships", value: 963, category: "People" },
  { label: "Clothing & uniforms", value: 1649, category: "People" },
  { label: "CPD / training budget", value: 10000, category: "People" },
  { label: "Legal fees", value: 38, category: "People" },
  { label: "Staff medical fees", value: 52, category: "People" },
  { label: "New equipment purchases", value: 5000, category: "Unexpected" },
  { label: "Unexpected maintenance / repairs", value: 0, category: "Unexpected" },
  { label: "Miscellaneous unexpected", value: 0, category: "Unexpected" },
  { label: "Other overhead 1", value: 0, category: "Other" },
  { label: "Other overhead 2", value: 0, category: "Other" },
  { label: "Other overhead 3", value: 0, category: "Other" },
];
const initialEquipment = [
  { name: "X-ray machine", status: "loan", price: 60000, age: 1, life: 15, loanRepay: 60000, maintenance: 2400, rate: 7.5, fee: 185, cogs: 22, vol: 150 },
  { name: "Dental machine", status: "owned", price: 28000, age: 5, life: 12, loanRepay: 0, maintenance: 1200, rate: 0, fee: 750, cogs: 45, vol: 60 },
  { name: "Anaesthetic machine", status: "owned", price: 18000, age: 3, life: 10, loanRepay: 0, maintenance: 868, rate: 0, fee: 120, cogs: 20, vol: 500 },
  { name: "Ultrasound", status: "loan", price: 32000, age: 2, life: 10, loanRepay: 3892, maintenance: 500, rate: 7.5, fee: 280, cogs: 35, vol: 30 },
];
const initialOtherIncome = [
  { category: "X-ray / imaging", annualRev: 27750, margin: 88, vol: 150, avgFee: 185 },
  { category: "Ultrasound", annualRev: 8400, margin: 88, vol: 30, avgFee: 280 },
  { category: "In-house lab (blood panel)", annualRev: 24000, margin: 77, vol: 200, avgFee: 120 },
  { category: "Non-routine surgery", annualRev: 42000, margin: 65, vol: 80, avgFee: 525 },
  { category: "Non-routine procedures", annualRev: 28000, margin: 60, vol: 120, avgFee: 233 },
  { category: "Prescription pet food", annualRev: 22000, margin: 35, vol: 0, avgFee: 0 },
  { category: "Flea, tick & worming products", annualRev: 14000, margin: 40, vol: 0, avgFee: 0 },
  { category: "Boarding", annualRev: 14000, margin: 70, vol: 0, avgFee: 0 },
  { category: "Grooming", annualRev: 8000, margin: 65, vol: 0, avgFee: 0 },
];
const initialLocumPeriods = [
  { reason: "Annual leave cover", month: "Jan 2026", days: 10, type: "Planned" },
  { reason: "Parental leave cover", month: "Mar–Jun 2026", days: 60, type: "Extended" },
  { reason: "Sick leave buffer", month: "Various", days: 10, type: "Buffer" },
];
const initialDisruptions = [
  { item: "Propofol (50ml vials)", normalCost: "$18.50/vial", altCost: "$31.00/vial", duration: "6 weeks", extraSpend: 1248, status: "Resolved" },
  { item: "IV catheters (18G)", normalCost: "$2.50 each", altCost: "$4.10 each", duration: "3 weeks", extraSpend: 384, status: "Back in stock" },
  { item: "Suture reels (2-0 PDS)", normalCost: "$136.99/reel", altCost: "$168.00/reel", duration: "Ongoing", extraSpend: 620, status: "Active" },
];
const initialRepairs = [
  { equipment: "Anaesthetic machine", date: "Mar 2026", cost: 3400, downtime: "4 days", notes: "Vaporiser seal failure" },
  { equipment: "Autoclave", date: "Jan 2026", cost: 890, downtime: "1 day", notes: "Heating element replaced" },
];
const initialDrugProtocols = [
  { name: "Dog neuter", drugs: [
    { name: "ACP", dose: 0.05, conc: 10, bottleSize: 10, bottleCost: 5.00 },
    { name: "Methadone", dose: 0.3, conc: 10, bottleSize: 10, bottleCost: 6.80 },
    { name: "Propofol", dose: 4, conc: 10, bottleSize: 20, bottleCost: 8.40 },
    { name: "Rimadyl (carprofen)", dose: 4, conc: 50, bottleSize: 20, bottleCost: 23.60 },
    { name: "Local anaesthetic", dose: 2, conc: 20, bottleSize: 20, bottleCost: 0.80 },
  ]},
  { name: "Dog spey", drugs: [
    { name: "ACP", dose: 0.05, conc: 10, bottleSize: 10, bottleCost: 5.00 },
    { name: "Methadone", dose: 0.4, conc: 10, bottleSize: 10, bottleCost: 6.80 },
    { name: "Ketamine", dose: 0.5, conc: 100, bottleSize: 10, bottleCost: 0.70 },
    { name: "Propofol", dose: 4, conc: 10, bottleSize: 20, bottleCost: 8.40 },
    { name: "Rimadyl (carprofen)", dose: 4, conc: 50, bottleSize: 20, bottleCost: 23.60 },
  ]},
  { name: "Cat neuter", drugs: [
    { name: "ACP", dose: 0.05, conc: 10, bottleSize: 10, bottleCost: 5.00 },
    { name: "Buprenorphine", dose: 0.02, conc: 0.3, bottleSize: 10, bottleCost: 34.00 },
    { name: "Propofol", dose: 4, conc: 10, bottleSize: 20, bottleCost: 8.40 },
  ]},
  { name: "Cat spey", drugs: [
    { name: "ACP", dose: 0.05, conc: 10, bottleSize: 10, bottleCost: 5.00 },
    { name: "Buprenorphine", dose: 0.02, conc: 0.3, bottleSize: 10, bottleCost: 34.00 },
    { name: "Propofol", dose: 4, conc: 10, bottleSize: 20, bottleCost: 8.40 },
    { name: "Meloxicam injection", dose: 0.2, conc: 5, bottleSize: 10, bottleCost: 5.10 },
  ]},
  { name: "Cat dental", drugs: [
    { name: "Medetomidine", dose: 0.02, conc: 1, bottleSize: 10, bottleCost: 33.00 },
    { name: "Methadone", dose: 0.2, conc: 10, bottleSize: 10, bottleCost: 6.80 },
    { name: "Propofol", dose: 4, conc: 10, bottleSize: 20, bottleCost: 8.40 },
    { name: "Meloxicam injection", dose: 0.2, conc: 5, bottleSize: 10, bottleCost: 5.10 },
  ]},
  { name: "Dog dental", drugs: [
    { name: "Medetomidine", dose: 0.02, conc: 1, bottleSize: 10, bottleCost: 33.00 },
    { name: "Methadone", dose: 0.3, conc: 10, bottleSize: 10, bottleCost: 6.80 },
    { name: "Propofol", dose: 4, conc: 10, bottleSize: 20, bottleCost: 8.40 },
    { name: "Rimadyl (carprofen)", dose: 4, conc: 50, bottleSize: 20, bottleCost: 23.60 },
  ]},
  { name: "Complex bitch spey", drugs: [
    { name: "ACP", dose: 0.05, conc: 10, bottleSize: 10, bottleCost: 5.00 },
    { name: "Methadone", dose: 0.4, conc: 10, bottleSize: 10, bottleCost: 6.80 },
    { name: "Ketamine", dose: 0.5, conc: 100, bottleSize: 10, bottleCost: 0.70 },
    { name: "Propofol", dose: 4, conc: 10, bottleSize: 20, bottleCost: 8.40 },
    { name: "Fentanyl CRI", dose: 0.003, conc: 0.05, bottleSize: 10, bottleCost: 18.00 },
    { name: "Rimadyl (carprofen)", dose: 4, conc: 50, bottleSize: 20, bottleCost: 23.60 },
  ]},
];
const initialConsults = [
  { name: "Initial consultation", vetMins: 20, nurseMins: 0, supportMins: 10, consumLevel: 1, markup: 1.10, extraItems: [], current: null, market: "$75–90", vol: 1200 },
  { name: "Follow-up consultation", vetMins: 15, nurseMins: 0, supportMins: 10, consumLevel: 1, markup: 0.80, extraItems: [], current: 39.60, market: "$59–65", vol: 1000 },
  { name: "Nurse consultation", vetMins: 0, nurseMins: 20, supportMins: 10, consumLevel: 1, markup: 1.10, extraItems: [], current: 26.62, market: "$35–50", vol: 400 },
  { name: "Vaccination — cat (single)", vetMins: 15, nurseMins: 0, supportMins: 10, consumLevel: 1, markup: 1.10, extraItems: [{ label: "Vaccine cost", cost: 10.12 }], current: 87.00, market: "$80–106", vol: 200 },
  { name: "Vaccination — dog (single)", vetMins: 15, nurseMins: 0, supportMins: 10, consumLevel: 1, markup: 1.10, extraItems: [{ label: "Vaccine cost", cost: 14.50 }], current: 95.00, market: "$90–110", vol: 200 },
  { name: "Vaccination — 2/3 course (cat)", vetMins: 30, nurseMins: 0, supportMins: 10, consumLevel: 1, markup: 1.10, extraItems: [{ label: "Vaccine x2", cost: 20.24 }], current: null, market: "$140–190", vol: 80 },
  { name: "Vaccination — 2/3 course (dog)", vetMins: 30, nurseMins: 0, supportMins: 10, consumLevel: 1, markup: 1.10, extraItems: [{ label: "Vaccine x2", cost: 29.00 }], current: null, market: "$160–210", vol: 80 },
];
const initialProcedures = [
  // Cat routine
  { name: "Kitten neuter <6M (<2kg)", category: "Cat routine", vetMins: 10, nurseMins: 15, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 0, consumLevel: 1, drugs: [{ name: "ACP", cost: 0.21 }, { name: "Buprenorphine", cost: 0.34 }, { name: "Propofol", cost: 0.21 }], current: 118.80, market: "$130–200", vol: 60 },
  { name: "Kitten spey <6M (<2kg)", category: "Cat routine", vetMins: 20, nurseMins: 30, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 20, consumLevel: 2, drugs: [{ name: "ACP", cost: 0.21 }, { name: "Buprenorphine", cost: 0.34 }, { name: "Propofol", cost: 0.21 }, { name: "Meloxicam inj", cost: 0.51 }], current: 184.80, market: "$180–270", vol: 50 },
  { name: "Cat neuter 6M+ (~4kg)", category: "Cat routine", vetMins: 10, nurseMins: 15, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 0, consumLevel: 1, drugs: [{ name: "ACP", cost: 0.42 }, { name: "Buprenorphine", cost: 0.68 }, { name: "Propofol", cost: 0.42 }], current: 118.00, market: "$130–200", vol: 80 },
  { name: "Cat spey 6M+ (~4kg)", category: "Cat routine", vetMins: 20, nurseMins: 30, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 20, consumLevel: 2, drugs: [{ name: "ACP", cost: 0.42 }, { name: "Buprenorphine", cost: 0.68 }, { name: "Propofol", cost: 0.42 }, { name: "Meloxicam inj", cost: 1.02 }], current: 184.00, market: "$180–270", vol: 80 },
  { name: "Cat spey — pregnant / on heat", category: "Cat routine", vetMins: 30, nurseMins: 45, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 30, consumLevel: 2, drugs: [{ name: "ACP", cost: 0.42 }, { name: "Buprenorphine", cost: 0.68 }, { name: "Propofol", cost: 0.42 }, { name: "Meloxicam inj", cost: 1.02 }], current: 231.00, market: "$280–360", vol: 20 },
  { name: "Cryptorchid neuter", category: "Cat routine", vetMins: 30, nurseMins: 30, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 20, consumLevel: 2, drugs: [{ name: "ACP", cost: 0.42 }, { name: "Buprenorphine", cost: 0.68 }, { name: "Propofol", cost: 0.42 }, { name: "Meloxicam inj", cost: 1.02 }], current: null, market: "$280–400", vol: 10 },
  // Dog routine
  { name: "Dog neuter <10kg", category: "Dog routine", vetMins: 15, nurseMins: 20, vet2Mins: 0, hospMins: 90, postOpMins: 15, isoMins: 15, consumLevel: 1, drugs: [{ name: "ACP", cost: 0.62 }, { name: "Methadone 0.3mg/kg", cost: 2.10 }, { name: "Local block", cost: 0.16 }, { name: "Propofol", cost: 1.00 }, { name: "Rimadyl inj", cost: 2.36 }, { name: "Rimadyl tabs x3", cost: 2.57 }], current: 242.00, market: "$270–330", vol: 50 },
  { name: "Dog neuter 10–20kg", category: "Dog routine", vetMins: 25, nurseMins: 30, vet2Mins: 0, hospMins: 90, postOpMins: 15, isoMins: 25, consumLevel: 2, drugs: [{ name: "ACP", cost: 1.24 }, { name: "Methadone 0.3mg/kg", cost: 4.20 }, { name: "Local block", cost: 0.32 }, { name: "Propofol", cost: 2.50 }, { name: "Rimadyl inj", cost: 4.72 }, { name: "Rimadyl tabs x3", cost: 5.75 }], current: 316.80, market: "$300–350", vol: 40 },
  { name: "Dog neuter 20–30kg", category: "Dog routine", vetMins: 30, nurseMins: 30, vet2Mins: 0, hospMins: 90, postOpMins: 15, isoMins: 30, consumLevel: 2, drugs: [{ name: "ACP", cost: 1.86 }, { name: "Methadone 0.3mg/kg", cost: 6.30 }, { name: "Local block", cost: 0.48 }, { name: "Propofol", cost: 4.00 }, { name: "Rimadyl inj", cost: 7.08 }, { name: "Rimadyl tabs x3", cost: 7.50 }], current: 381.70, market: "$350–400", vol: 30 },
  { name: "Dog neuter 30kg+", category: "Dog routine", vetMins: 40, nurseMins: 40, vet2Mins: 0, hospMins: 90, postOpMins: 15, isoMins: 40, consumLevel: 2, drugs: [{ name: "ACP", cost: 2.48 }, { name: "Methadone 0.3mg/kg", cost: 8.40 }, { name: "Local block", cost: 0.64 }, { name: "Propofol", cost: 5.50 }, { name: "Rimadyl inj", cost: 9.44 }, { name: "Rimadyl tabs x3", cost: 7.50 }], current: 448.50, market: "$380–470", vol: 20 },
  { name: "Bitch spey <10kg", category: "Dog routine", vetMins: 50, nurseMins: 50, vet2Mins: 0, hospMins: 90, postOpMins: 15, isoMins: 50, consumLevel: 2, drugs: [{ name: "ACP", cost: 0.62 }, { name: "Methadone 0.4mg/kg", cost: 2.10 }, { name: "Ketamine 0.5mg/kg", cost: 0.14 }, { name: "Propofol", cost: 1.00 }, { name: "Rimadyl inj", cost: 2.36 }], current: 368.50, market: "$420–450", vol: 40 },
  { name: "Bitch spey 10–20kg", category: "Dog routine", vetMins: 60, nurseMins: 55, vet2Mins: 0, hospMins: 90, postOpMins: 15, isoMins: 60, consumLevel: 3, drugs: [{ name: "ACP", cost: 1.24 }, { name: "Methadone 0.4mg/kg", cost: 4.20 }, { name: "Ketamine 0.5mg/kg", cost: 0.28 }, { name: "Propofol", cost: 2.50 }, { name: "Rimadyl inj", cost: 4.72 }], current: 421.00, market: "$440–550", vol: 35 },
  { name: "Bitch spey 20–30kg", category: "Dog routine", vetMins: 70, nurseMins: 55, vet2Mins: 0, hospMins: 90, postOpMins: 15, isoMins: 70, consumLevel: 3, drugs: [{ name: "ACP", cost: 1.86 }, { name: "Methadone 0.4mg/kg", cost: 6.30 }, { name: "Ketamine 0.5mg/kg", cost: 0.42 }, { name: "Propofol", cost: 4.00 }, { name: "Rimadyl inj", cost: 7.08 }], current: 421.00, market: "$470–600", vol: 25 },
  { name: "Bitch spey 30kg+", category: "Dog routine", vetMins: 85, nurseMins: 55, vet2Mins: 0, hospMins: 90, postOpMins: 15, isoMins: 85, consumLevel: 3, drugs: [{ name: "ACP", cost: 2.48 }, { name: "Methadone 0.4mg/kg", cost: 8.40 }, { name: "Ketamine 0.5mg/kg", cost: 0.56 }, { name: "Propofol", cost: 5.50 }, { name: "Rimadyl inj", cost: 9.44 }], current: 543.40, market: "$500–850", vol: 15 },
  { name: "Complex bitch spey <15kg", category: "Dog routine", vetMins: 90, nurseMins: 75, vet2Mins: 30, hospMins: 120, postOpMins: 15, isoMins: 90, consumLevel: 3, drugs: [{ name: "ACP", cost: 1.24 }, { name: "Methadone 0.4mg/kg", cost: 4.20 }, { name: "Ketamine 0.5mg/kg", cost: 0.28 }, { name: "Propofol", cost: 2.50 }, { name: "Rimadyl inj", cost: 4.72 }, { name: "Fentanyl CRI", cost: 8.50 }], current: null, market: "$650–900", vol: 10 },
  { name: "Complex bitch spey >15kg", category: "Dog routine", vetMins: 100, nurseMins: 75, vet2Mins: 30, hospMins: 120, postOpMins: 15, isoMins: 100, consumLevel: 3, drugs: [{ name: "ACP", cost: 2.48 }, { name: "Methadone 0.4mg/kg", cost: 8.40 }, { name: "Ketamine 0.5mg/kg", cost: 0.56 }, { name: "Propofol", cost: 5.50 }, { name: "Rimadyl inj", cost: 9.44 }, { name: "Fentanyl CRI", cost: 12.00 }], current: null, market: "$800–1,200", vol: 8 },
  // Cat dental
  { name: "Cat dental grade 1–2", category: "Cat dental", vetMins: 30, nurseMins: 60, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 30, consumLevel: 2, drugs: [{ name: "Medetomidine", cost: 3.30 }, { name: "Methadone 0.2mg/kg", cost: 1.36 }, { name: "Propofol", cost: 0.84 }, { name: "Meloxicam inj", cost: 1.02 }], current: null, market: "$600–800", vol: 40 },
  { name: "Cat dental grade 3", category: "Cat dental", vetMins: 60, nurseMins: 90, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 60, consumLevel: 2, drugs: [{ name: "Medetomidine", cost: 3.30 }, { name: "Methadone 0.2mg/kg", cost: 1.36 }, { name: "Propofol", cost: 0.84 }, { name: "Meloxicam inj", cost: 1.02 }], current: null, market: "$800–1,600", vol: 15 },
  { name: "Cat dental grade 4", category: "Cat dental", vetMins: 90, nurseMins: 120, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 90, consumLevel: 2, drugs: [{ name: "Medetomidine", cost: 3.30 }, { name: "Methadone 0.2mg/kg", cost: 1.36 }, { name: "Propofol", cost: 0.84 }, { name: "Meloxicam inj", cost: 1.02 }], current: null, market: "$1,500–3,000", vol: 8 },
  // Dog dental
  { name: "Dog dental grade 1–2 (<15kg)", category: "Dog dental", vetMins: 30, nurseMins: 60, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 30, consumLevel: 2, drugs: [{ name: "Medetomidine", cost: 3.30 }, { name: "Methadone 0.3mg/kg", cost: 2.10 }, { name: "Propofol", cost: 1.00 }, { name: "Rimadyl inj", cost: 2.36 }], current: null, market: "$600–850", vol: 30 },
  { name: "Dog dental grade 1–2 (>15kg)", category: "Dog dental", vetMins: 30, nurseMins: 60, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 30, consumLevel: 2, drugs: [{ name: "Medetomidine", cost: 3.30 }, { name: "Methadone 0.3mg/kg", cost: 4.20 }, { name: "Propofol", cost: 2.50 }, { name: "Rimadyl inj", cost: 4.72 }], current: null, market: "$600–850", vol: 20 },
  { name: "Dog dental grade 3 (<15kg)", category: "Dog dental", vetMins: 60, nurseMins: 90, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 60, consumLevel: 2, drugs: [{ name: "Medetomidine", cost: 3.30 }, { name: "Methadone 0.3mg/kg", cost: 2.10 }, { name: "Propofol", cost: 1.00 }, { name: "Rimadyl inj", cost: 2.36 }], current: null, market: "$900–1,500", vol: 15 },
  { name: "Dog dental grade 3 (>15kg)", category: "Dog dental", vetMins: 60, nurseMins: 90, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 60, consumLevel: 2, drugs: [{ name: "Medetomidine", cost: 3.30 }, { name: "Methadone 0.3mg/kg", cost: 4.20 }, { name: "Propofol", cost: 2.50 }, { name: "Rimadyl inj", cost: 4.72 }], current: null, market: "$900–1,500", vol: 10 },
  { name: "Dog dental grade 4 (<15kg)", category: "Dog dental", vetMins: 90, nurseMins: 120, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 90, consumLevel: 2, drugs: [{ name: "Medetomidine", cost: 3.30 }, { name: "Methadone 0.3mg/kg", cost: 2.10 }, { name: "Propofol", cost: 1.00 }, { name: "Rimadyl inj", cost: 2.36 }], current: null, market: "$1,500–2,500", vol: 5 },
  { name: "Dog dental grade 4 (>15kg)", category: "Dog dental", vetMins: 90, nurseMins: 120, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 90, consumLevel: 2, drugs: [{ name: "Medetomidine", cost: 3.30 }, { name: "Methadone 0.3mg/kg", cost: 4.20 }, { name: "Propofol", cost: 2.50 }, { name: "Rimadyl inj", cost: 4.72 }], current: null, market: "$1,500–2,500", vol: 5 },
];

// ── CSS ───────────────────────────────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --g:#1D9E75;--gd:#0F6E56;--gb:#E1F5EE;--gt:#085041;
  --bg:#F7F6F2;--surface:#FFFFFF;--surface2:#F2F1ED;
  --border:rgba(0,0,0,0.08);--border2:rgba(0,0,0,0.14);
  --text:#1A1A18;--text2:#5A5A56;--text3:#9A9A94;
  --mono:'DM Mono',monospace;--radius:10px;--radius-sm:6px;
  --red:#D94F4F;--amber:#C47C1A;--amber-bg:#FEF3E2;
  --blue:#185FA5;--blue-bg:#E6F1FB;--blue-border:#B5D4F4;
}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5}
.app{display:flex;height:100vh;overflow:hidden}
.sidebar{width:220px;min-width:220px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto}
.logo-area{padding:16px 15px 11px;border-bottom:1px solid var(--border)}
.logo-mark{display:flex;align-items:center;gap:8px;margin-bottom:2px}
.logo-dot{width:26px;height:26px;background:var(--g);border-radius:7px;display:flex;align-items:center;justify-content:center}
.logo-dot svg{width:14px;height:14px;fill:white}
.logo-name{font-size:14px;font-weight:600;letter-spacing:-0.3px}
.logo-tag{font-size:10px;color:var(--text3);padding-left:34px}
.clinic-pill{margin:9px 9px 3px;background:var(--bg);border-radius:var(--radius-sm);padding:8px 10px;border:1px solid var(--border)}
.clinic-name{font-size:12px;font-weight:500}
.clinic-meta{font-size:10px;color:var(--text3);margin-top:1px}
.nav-section{font-size:9px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.09em;padding:11px 15px 2px}
.nav-item{display:flex;align-items:center;gap:8px;padding:7px 15px;font-size:12px;cursor:pointer;color:var(--text2);border-right:2px solid transparent;transition:all 0.1s;user-select:none}
.nav-item:hover{background:var(--bg);color:var(--text)}
.nav-item.active{background:var(--gb);color:var(--gt);font-weight:500;border-right-color:var(--g)}
.nav-badge{font-size:9px;background:var(--g);color:white;border-radius:10px;padding:1px 5px;margin-left:auto}
.main{flex:1;min-width:0;overflow-y:auto}
.topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:20}
.topbar-left h1{font-size:15px;font-weight:600;letter-spacing:-0.3px}
.topbar-left p{font-size:11px;color:var(--text3);margin-top:1px}
.topbar-actions{display:flex;gap:7px;align-items:center}
.btn{padding:5px 12px;border-radius:var(--radius-sm);border:1px solid var(--border2);background:var(--surface);font-size:12px;font-weight:500;cursor:pointer;color:var(--text);display:inline-flex;align-items:center;gap:5px;font-family:inherit;transition:all 0.1s}
.btn:hover{background:var(--bg)}
.btn.primary{background:var(--g);color:white;border-color:var(--g)}
.btn.primary:hover{background:var(--gd)}
.btn.outline-g{border-color:var(--g);color:var(--g)}
.btn.sm{padding:3px 8px;font-size:11px}
.btn.danger-sm{padding:3px 7px;font-size:11px;border-color:#fca5a5;color:var(--red);background:#fff5f5}
.btn.sel{background:var(--gb);color:var(--gt);border-color:#5DCAA5}
.content{padding:16px 20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:13px;overflow:hidden}
.card-header{padding:11px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px}
.card-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
.card-footer{padding:8px 16px;background:var(--surface2);border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text2);flex-wrap:wrap;gap:6px}
.card-footer strong{color:var(--text);font-weight:600}
.metrics-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:13px}
.metric{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px}
.metric-label{font-size:10px;color:var(--text3);font-weight:500;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px}
.metric-value{font-size:20px;font-weight:600;letter-spacing:-0.5px}
.metric-sub{font-size:10px;color:var(--text3);margin-top:2px}
.metric-value.green{color:var(--g)}
.metric-value.red{color:var(--red)}
.metric-value.amber{color:var(--amber)}
.tbl{width:100%;border-collapse:collapse}
.tbl th{font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;padding:7px 12px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}
.tbl th.r,.tbl td.r{text-align:right}
.tbl td{padding:6px 12px;font-size:12px;border-bottom:1px solid var(--border);vertical-align:middle}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:var(--bg)}
.tbl tr.total-row td{font-weight:600;background:var(--surface2)}
.tbl tr.net-row td{font-size:14px;font-weight:600;border-top:2px solid var(--border2)}
.mono{font-family:var(--mono);font-size:12px}
.green{color:var(--g)}
.red{color:var(--red)}
.amber{color:var(--amber)}
.badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:600}
.badge.ok{background:#D1FAE5;color:#065F46}
.badge.warn{background:#FEF3C7;color:#92400E}
.badge.bad{background:#FEE2E2;color:#991B1B}
.badge.info{background:#DBEAFE;color:#1E40AF}
.field{display:flex;flex-direction:column;gap:4px}
.field label{font-size:11px;font-weight:500;color:var(--text2)}
.input{width:100%;padding:6px 8px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--surface);font-size:12px;color:var(--text);font-family:inherit}
.input:focus{outline:none;border-color:var(--g);box-shadow:0 0 0 3px rgba(29,158,117,0.1)}
.input.r{text-align:right}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:11px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.grid5{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.padded{padding:13px 16px}
.tab-bar{display:flex;border-bottom:1px solid var(--border);overflow-x:auto}
.tab{padding:8px 14px;font-size:12px;font-weight:500;cursor:pointer;color:var(--text3);border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tab:hover{color:var(--text)}
.tab.active{color:var(--g);border-bottom-color:var(--g)}
.section-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:var(--text3);padding:6px 16px 4px;background:var(--surface2);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.oh-grid{display:grid;grid-template-columns:1fr 1fr 1fr}
.oh-item{padding:6px 13px;border-bottom:1px solid var(--border);border-right:1px solid var(--border)}
.oh-item:nth-child(3n){border-right:none}
.oh-item label{display:block;font-size:10px;color:var(--text3);margin-bottom:2px;font-weight:500}
.oh-input{width:100%;border:none;background:transparent;font-size:12px;font-family:var(--mono);color:var(--text);padding:0}
.oh-input:focus{outline:none;color:var(--g)}
.drug-grid{display:grid;grid-template-columns:160px 72px 70px 70px 72px 82px 72px 72px 32px;gap:4px;align-items:center;padding:6px 13px;border-bottom:1px solid var(--border)}
.drug-grid.hdr{font-size:9px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;background:var(--surface2)}
.drug-input{width:100%;padding:3px 5px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);font-size:11px;font-family:inherit;color:var(--text);text-align:right}
.drug-input.left{text-align:left}
.drug-input:focus{outline:none;border-color:var(--g)}
.info-bar{display:flex;align-items:flex-start;gap:7px;padding:8px 16px;background:var(--gb);border-bottom:1px solid rgba(29,158,117,0.2);font-size:11px;color:var(--gt);line-height:1.6}
.pl-section{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:var(--text3);padding:6px 16px;background:var(--surface2);border-bottom:1px solid var(--border);border-top:1px solid var(--border);margin-top:2px}
.pl-tooltip{font-size:9px;color:var(--text3);font-style:italic;margin-left:4px;font-weight:400;text-transform:none;letter-spacing:0}
.tax-box{background:var(--blue-bg);border:1px solid var(--blue-border);border-radius:var(--radius);padding:13px 16px;margin-bottom:13px}
.tax-title{font-size:12px;font-weight:600;color:var(--blue);margin-bottom:9px}
.tax-row{display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:0.5px solid var(--blue-border)}
.tax-row:last-child{border-bottom:none;font-weight:600}
.alert{display:flex;align-items:flex-start;gap:9px;padding:10px 14px;border-radius:var(--radius);margin-bottom:13px;font-size:12px}
.alert.warn{background:var(--amber-bg);border:1px solid #F6D28A;color:#92400E}
.alert.info{background:var(--gb);border:1px solid rgba(29,158,117,0.3);color:var(--gt)}
.breakdown-box{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;font-size:11px}
.breakdown-row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:0.5px solid var(--border)}
.breakdown-row:last-child{border-bottom:none;font-weight:600}
.breakdown-label{color:var(--text2)}
.breakdown-val{font-family:var(--mono)}
.scenario-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;padding:13px 16px;border-bottom:1px solid var(--border)}
.scenario-card{border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 7px;text-align:center;cursor:pointer;transition:all 0.15s}
.scenario-card:hover,.scenario-card.active{border-color:var(--g)}
.scenario-card.active{background:var(--gb)}
.scenario-card .sy{font-size:17px;font-weight:600;margin-bottom:2px}
.scenario-card.active .sy{color:var(--gt)}
.scenario-card .sl{font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:7px}
.scenario-card.active .sl{color:var(--gt)}
.scenario-card .sv{font-size:11px;font-weight:500;font-family:var(--mono)}
.scenario-card.active .sv{color:var(--gt)}
.scenario-card .ss{font-size:9px;color:var(--text3);margin-top:2px}
.progress-track{height:9px;background:var(--surface2);border-radius:5px;overflow:hidden;margin:3px 0 10px}
.progress-fill{height:100%;border-radius:5px;transition:width 0.4s,background 0.4s}
.whatif-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;padding:11px 16px;background:var(--surface2);border-top:1px solid var(--border)}
.whatif-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px;text-align:center}
.whatif-label{font-size:10px;color:var(--text3);margin-bottom:2px}
.whatif-val{font-size:14px;font-weight:600}
.whatif-sub{font-size:10px;color:var(--text3);margin-top:2px}
.toggle-group{display:flex;border:1px solid var(--border2);border-radius:var(--radius-sm);overflow:hidden}
.toggle-btn{padding:5px 12px;font-size:11px;font-weight:500;cursor:pointer;border:none;background:transparent;color:var(--text2);font-family:inherit}
.toggle-btn.active{background:var(--g);color:white}
.payoff-tab{padding:5px 11px;border-radius:20px;font-size:11px;font-weight:500;cursor:pointer;border:1px solid var(--border2);background:var(--surface);color:var(--text2);transition:all 0.1s}
.payoff-tab:hover{border-color:var(--g)}
.payoff-tab.active{background:var(--gb);color:var(--gt);border-color:#5DCAA5}
.pricing-row-expanded{background:var(--gb);border-bottom:1px solid rgba(29,158,117,0.2)}
.vol-slider{width:80px;vertical-align:middle;accent-color:var(--g)}
.util-bar{height:8px;border-radius:4px;background:var(--surface2);overflow:hidden;flex:1}
.util-fill{height:100%;border-radius:4px;transition:width 0.3s}
.sim-slider{width:100%;accent-color:var(--g);margin:6px 0}
`;

// ── Shared components ──────────────────────────────────────────────────────────
function Icon({ d, size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d={d} /></svg>;
}
const ICONS = {
  dashboard: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10",
  overheads: "M3 21h18M6 21V7l6-4 6 4v14M9 21v-4h6v4",
  income: "M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6",
  drugs: "M9 3h6l1 5H8l1-5zm-1 5v2a5 5 0 0010 0V8M6 21h12",
  equip: "M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18",
  pricing: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586l5.414 5.414V19a2 2 0 01-2 2z",
  pl: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10",
  locum: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  disruption: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  health: "M22 12h-4l-3 9L9 3l-3 9H2",
  simulator: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  export: "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4",
};
function Badge({ type, children }) { return <span className={`badge ${type}`}>{children}</span>; }
function MetricCard({ label, value, sub, color }) {
  return <div className="metric"><div className="metric-label">{label}</div><div className={`metric-value ${color || ""}`}>{value}</div>{sub && <div className="metric-sub">{sub}</div>}</div>;
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
function Dashboard({ state, setPage }) {
  const { ohPerEvent, totalCostBase } = state.computed;
  const totalEvents = Object.values(state.volumes).reduce((a, v) => a + v, 0);
  const otherIncomeExGST = state.otherIncome.reduce((a, r) => a + r.annualRev / GST, 0);
  const allServices = [...state.consults, ...state.procedures];
  const servicesUnder = allServices.filter(s => s.current && s.minPriceInc && s.current < s.minPriceInc);

  // Pricing leakage: services with a current price below recommended
  const leakageItems = allServices
    .filter(s => s.current && s.minPriceInc && s.current < s.minPriceInc && s.vol)
    .map(s => {
      const gap = s.minPriceInc - s.current;
      const annualOpportunity = gap * s.vol;
      return { ...s, gap, annualOpportunity };
    })
    .sort((a, b) => b.annualOpportunity - a.annualOpportunity)
    .slice(0, 8);

  const totalLeakage = leakageItems.reduce((a, s) => a + s.annualOpportunity, 0);
  const targetRevenue = totalCostBase / 0.9; // revenue needed for 10% operating surplus

  return (
    <>
      <div className="topbar">
        <div className="topbar-left"><h1>Dashboard</h1><p>Tasman Vets · FY2025–26</p></div>
        <div className="topbar-actions"><button className="btn primary"><Icon d={ICONS.export} /> Export price list</button></div>
      </div>
      <div className="content">
        {servicesUnder.length > 0 && (
          <div className="alert warn">⚠️ <span><strong>{servicesUnder.length} services</strong> are priced below cost recovery. See the pricing leakage table below.</span></div>
        )}
        <div className="metrics-row">
          <MetricCard label="Annual cost base (ex GST)" value={fmtK(totalCostBase)} sub="All overheads combined" />
          <MetricCard label="Overhead per billable event" value={fmt(ohPerEvent)} sub={`${fmtI(totalEvents)} events/yr`} />
          <MetricCard label="Services under cost" value={`${servicesUnder.length} / ${allServices.length}`} sub="Review pricing page" color={servicesUnder.length > 0 ? "red" : "green"} />
          <MetricCard label="Revenue target (10% surplus)" value={fmtK(targetRevenue)} sub="Required for 10% operating surplus" color="amber" />
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">💸 Pricing leakage — revenue you're leaving on the table</div>
            <button className="btn sm" onClick={() => setPage("pricing")}>Fix prices →</button>
          </div>
          {leakageItems.length === 0 ? (
            <div style={{ padding: "20px 16px", color: "var(--text3)", fontSize: 12, textAlign: "center" }}>No pricing leakage detected — all services with a current price are above cost recovery. 🎉</div>
          ) : (
            <>
              <table className="tbl">
                <thead><tr><th>Service</th><th className="r">Your price</th><th className="r">Min price (inc GST)</th><th className="r">Gap per service</th><th className="r">Annual opportunity</th><th>Status</th></tr></thead>
                <tbody>
                  {leakageItems.map(s => (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td className="r mono">{fmt(s.current)}</td>
                      <td className="r mono">{fmt(s.minPriceInc)}</td>
                      <td className="r mono red">{fmt(s.gap)}</td>
                      <td className="r mono amber">{fmt(s.annualOpportunity)}</td>
                      <td><Badge type="bad">Under cost</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="card-footer">
                <span>Total annual revenue opportunity: <strong className="amber">{fmt(totalLeakage)}</strong></span>
                <span style={{ fontSize: 11, color: "var(--text3)" }}>Recovering this leakage improves your operating surplus by the same amount.</span>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">📊 Annual cost base breakdown</div></div>
          <table className="tbl">
            <thead><tr><th>Category</th><th className="r">Annual cost (ex GST)</th><th className="r">Per event</th><th className="r">% of total</th></tr></thead>
            <tbody>
              <tr><td>Wages & base overheads</td><td className="r mono">{fmt(state.computed.baseOH)}</td><td className="r mono">{fmt(state.computed.baseOH / (totalEvents || 1))}</td><td className="r">{((state.computed.baseOH / totalCostBase) * 100).toFixed(1)}%</td></tr>
              <tr><td>Equipment (depreciation + loans)</td><td className="r mono">{fmt(state.computed.equipTotal)}</td><td className="r mono">{fmt(state.computed.equipTotal / (totalEvents || 1))}</td><td className="r">{((state.computed.equipTotal / totalCostBase) * 100).toFixed(1)}%</td></tr>
              <tr><td>Contingency buffer</td><td className="r mono">{fmt(state.computed.contingency)}</td><td className="r mono">{fmt(state.computed.contingency / (totalEvents || 1))}</td><td className="r">{((state.computed.contingency / totalCostBase) * 100).toFixed(1)}%</td></tr>
              <tr className="total-row"><td>Total annual cost base</td><td className="r mono">{fmt(totalCostBase)}</td><td className="r mono">{fmt(ohPerEvent)}</td><td className="r">100%</td></tr>
            </tbody>
          </table>
          <div className="card-footer">
            <span>Revenue required at <strong>10% operating surplus target:</strong> <strong className="green">{fmt(targetRevenue)}</strong></span>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Wages & Overheads ──────────────────────────────────────────────────────────
function OverheadsPage({ state, update }) {
  const categories = ["Premises", "Equipment", "Technology", "Operations", "People", "Unexpected", "Other"];
  const total = state.overheads.reduce((a, o) => a + (parseFloat(o.value) || 0), 0);
  const totalEvents = Object.values(state.volumes).reduce((a, v) => a + v, 0);
  const isoPerMin = state.iso.costPerWeek / 7 / 8 / 60;
  const [staffCounts, setStaffCounts] = useState({ vets: 2, nurses: 3, support: 2, managers: 1 });
  const [hoursPerWeek, setHoursPerWeek] = useState(40);
  const [weeksPerYear, setWeeksPerYear] = useState(46);
  const totalWageBill = (
    staffCounts.vets * state.wages.vet +
    staffCounts.nurses * state.wages.nurse +
    staffCounts.support * state.wages.support +
    staffCounts.managers * state.wages.manager
  ) * hoursPerWeek * weeksPerYear;

  return (
    <>
      <div className="topbar">
        <div className="topbar-left"><h1>Wages & overheads</h1><p>All annual costs that feed into your pricing</p></div>
        <div className="topbar-actions"><button className="btn primary">✓ Save & recalculate</button></div>
      </div>
      <div className="content">
        <div className="card">
          <div className="card-header"><div className="card-title">👤 Hourly wage rates (ex GST, top of scale)</div></div>
          <div className="padded grid5">
            {[["Veterinarian", "vet"], ["Vet nurse", "nurse"], ["Receptionist/support", "support"], ["Practice manager", "manager"], ["Locum vet rate", "locum"]].map(([label, key]) => (
              <div className="field" key={key}><label>{label} ($/hr)</label><input className="input r" type="number" value={state.wages[key]} onChange={e => update("wage", { key, val: +e.target.value })} /></div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">💰 Total annual wage bill calculator</div></div>
          <div className="info-bar">ℹ️ Enter your staffing numbers to see your total annual wage cost. This is separate from the per-procedure time allocation used in pricing.</div>
          <div className="padded grid4">
            {[["Number of vets (FTE)", "vets"], ["Number of vet nurses (FTE)", "nurses"], ["Number of support staff (FTE)", "support"], ["Number of managers (FTE)", "managers"]].map(([label, key]) => (
              <div className="field" key={key}><label>{label}</label><input className="input r" type="number" value={staffCounts[key]} onChange={e => setStaffCounts(p => ({ ...p, [key]: +e.target.value }))} /></div>
            ))}
            <div className="field"><label>Clinical hours / week (per person)</label><input className="input r" type="number" value={hoursPerWeek} onChange={e => setHoursPerWeek(+e.target.value)} /></div>
            <div className="field"><label>Working weeks / year</label><input className="input r" type="number" value={weeksPerYear} onChange={e => setWeeksPerYear(+e.target.value)} /></div>
            <div className="field"><label>Total annual wage bill</label><input className="input r" readOnly value={fmt(totalWageBill)} style={{ background: "var(--gb)", color: "var(--gt)", fontWeight: 500 }} /></div>
            <div className="field"><label>Wage cost per billable event</label><input className="input r" readOnly value={fmt(totalWageBill / (totalEvents || 1))} style={{ background: "var(--surface2)" }} /></div>
          </div>
          <div className="card-footer"><span style={{ fontSize: 11, color: "var(--text3)" }}>Your total payroll cost. Individual procedure pricing uses time-based wage allocation (vet/nurse minutes per procedure).</span></div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">🏢 Annual overhead costs (ex GST)</div>
            <button className="btn sm" onClick={() => update("addOverhead")}>+ Add overhead</button>
          </div>
          {categories.map(cat => {
            const items = state.overheads.map((o, i) => ({ ...o, i })).filter(o => o.category === cat);
            if (!items.length) return null;
            return (
              <div key={cat}>
                <div className="section-label">{cat}</div>
                <div className="oh-grid">
                  {items.map(({ label, value, i }) => (
                    <div className="oh-item" key={i}>
                      <label>{label}</label>
                      <input className="oh-input" type="number" defaultValue={value} onBlur={e => update("overhead", { i, field: "value", val: +e.target.value })} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="card-footer">
            <span>Total overheads: <strong>{fmt(total)}</strong></span>
            <span>Per billable event: <strong>{fmt(total / (totalEvents || 1))}</strong></span>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">📊 Annual procedure volumes</div></div>
          <div className="padded grid5">
            {[["Consultations / yr", "consults"], ["Routine procedures / yr", "routine"], ["Dental procedures / yr", "dental"], ["Nurse consults / yr", "nurse"], ["Non-routine procedures / yr", "nonRoutine"]].map(([label, key]) => (
              <div className="field" key={key}><label>{label}</label><input className="input r" type="number" value={state.volumes[key]} onChange={e => update("volume", { key, val: +e.target.value })} /></div>
            ))}
          </div>
          <div className="card-footer">
            <span>Total billable events: <strong>{fmtI(totalEvents)}</strong></span>
            <span>ISO cost per min of anaesthesia: <strong>{fmt(isoPerMin)}</strong> (at {fmt(state.iso.costPerWeek)}/wk)</span>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">🔥 Isoflurane cost</div></div>
          <div className="padded grid3">
            <div className="field"><label>ISO cost per week (ex GST)</label><input className="input r" type="number" value={state.iso.costPerWeek} onChange={e => update("iso", { val: +e.target.value })} /></div>
            <div className="field"><label>ISO cost per minute (calculated)</label><input className="input r" readOnly value={fmt(isoPerMin)} style={{ background: "var(--surface2)" }} /></div>
            <div className="field"><label>Basis</label><input className="input r" readOnly value="8-hr clinical day, 7 days/wk" style={{ background: "var(--surface2)", color: "var(--text3)" }} /></div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Other Income ───────────────────────────────────────────────────────────────
function OtherIncomePage({ state, update }) {
  const total = state.otherIncome.reduce((a, r) => a + r.annualRev, 0);
  const totalProfit = state.otherIncome.reduce((a, r) => a + r.annualRev * r.margin / 100, 0);
  return (
    <>
      <div className="topbar">
        <div className="topbar-left"><h1>Other income streams</h1><p>All income beyond consultations, routine surgery, and dentals</p></div>
        <div className="topbar-actions">
          <button className="btn" onClick={() => update("addOtherIncome")}>+ Add income stream</button>
          <button className="btn primary">✓ Save</button>
        </div>
      </div>
      <div className="content">
        <div className="info-bar" style={{ borderRadius: "var(--radius)", marginBottom: 13, border: "1px solid rgba(29,158,117,0.2)" }}>ℹ️ Include here: non-routine surgery, non-routine procedures, emergency work, imaging, retail, boarding, grooming, and any other revenue your clinic generates.</div>
        <div className="card">
          <div className="card-header"><div className="card-title">💰 Other income streams</div></div>
          <table className="tbl">
            <thead><tr><th>Category / income stream</th><th className="r">Annual revenue (inc GST)</th><th className="r">Gross margin %</th><th className="r">Gross profit</th><th></th></tr></thead>
            <tbody>
              {state.otherIncome.map((r, i) => (
                <tr key={i}>
                  <td><input value={r.category} onChange={e => update("otherIncomeField", { i, field: "category", val: e.target.value })} style={{ border: "none", background: "transparent", fontSize: 12, width: "100%", fontFamily: "inherit", color: "var(--text)" }} /></td>
                  <td className="r"><input type="number" value={r.annualRev} onChange={e => update("otherIncomeField", { i, field: "annualRev", val: +e.target.value })} style={{ width: 95, textAlign: "right", border: "1px solid var(--border2)", borderRadius: 4, padding: "3px 6px", fontSize: 11, fontFamily: "var(--mono)", background: "var(--surface)", color: "var(--text)" }} /></td>
                  <td className="r"><input type="number" value={r.margin} onChange={e => update("otherIncomeField", { i, field: "margin", val: +e.target.value })} style={{ width: 50, textAlign: "right", border: "1px solid var(--border2)", borderRadius: 4, padding: "3px 6px", fontSize: 11, fontFamily: "var(--mono)", background: "var(--surface)", color: "var(--text)" }} />%</td>
                  <td className="r mono green">{fmt(r.annualRev * r.margin / 100)}</td>
                  <td><button className="btn danger-sm" onClick={() => update("removeOtherIncome", i)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="card-footer">
            <span>Total other income: <strong>{fmt(total)}</strong> inc GST</span>
            <span>Total gross profit: <strong className="green">{fmt(totalProfit)}</strong></span>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Drug Protocol Builder ──────────────────────────────────────────────────────
function DrugProtocolPage({ state, update }) {
  const [procIdx, setProcIdx] = useState(0);
  const [weight, setWeight] = useState(15);
  const proc = state.drugProtocols[procIdx];
  const totals = useMemo(() => {
    let cost = 0, sell = 0;
    (proc?.drugs || []).forEach(d => { const r = calcDrugCost(d, weight); cost += r.cost; sell += r.sell; });
    return { cost, sell };
  }, [proc, weight]);

  return (
    <>
      <div className="topbar">
        <div className="topbar-left"><h1>Drug protocol builder</h1><p>Drug costs here feed directly into the cost breakdown for each procedure on the pricing page</p></div>
        <div className="topbar-actions">
          <button className="btn" onClick={() => update("addDrug", procIdx)}>+ Add drug</button>
          <button className="btn primary">✓ Save protocol</button>
        </div>
      </div>
      <div className="content">
        <div className="info-bar" style={{ borderRadius: "var(--radius)", marginBottom: 13, border: "1px solid rgba(29,158,117,0.2)" }}>
          💊 <strong>Why this page matters:</strong> The drugs you enter here — dose rates, concentrations, bottle costs — are used to calculate the true drug cost of each procedure. Change a drug, dose, or price and your recommended fees on the pricing page update automatically. Dead space loss (0.005ml per draw) is included in every calculation.
        </div>
        <div className="card">
          <div className="card-header">
            <div className="card-title">🐾 Select procedure</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
              <span style={{ color: "var(--text3)" }}>Patient weight:</span>
              <input type="range" min={0.5} max={50} step={0.5} value={weight} onChange={e => setWeight(+e.target.value)} style={{ width: 100, accentColor: "var(--g)" }} />
              <span style={{ fontWeight: 600, minWidth: 42, fontFamily: "var(--mono)" }}>{weight.toFixed(1)} kg</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "10px 15px", borderBottom: "1px solid var(--border)" }}>
            {state.drugProtocols.map((p, i) => (
              <button key={i} className={`payoff-tab${i === procIdx ? " active" : ""}`} onClick={() => setProcIdx(i)}>{p.name}</button>
            ))}
            <button className="payoff-tab" onClick={() => update("addProcedure")} style={{ borderStyle: "dashed" }}>+ New procedure</button>
          </div>
          <div style={{ display: "flex", gap: 7, padding: "8px 15px", flexWrap: "wrap", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
            {[["Kitten/cat", 2], ["Adult cat", 4.5], ["Small dog", 8], ["Medium dog", 15], ["Large dog", 25], ["Giant breed", 40]].map(([label, w]) => (
              <button key={label} className="btn sm" onClick={() => setWeight(w)}>{label} ({w}kg)</button>
            ))}
          </div>
          <div className="drug-grid hdr">
            <span>Drug name</span><span>Dose mg/kg</span><span>Conc mg/ml</span><span>Bottle ml</span><span>Bottle cost $</span><span>Vol drawn ml</span><span>Dead space $</span><span>Cost/patient</span><span></span>
          </div>
          {(proc?.drugs || []).map((d, di) => {
            const r = calcDrugCost(d, weight);
            return (
              <div key={di} className="drug-grid">
                <input className="drug-input left" value={d.name} onChange={e => update("drugField", { procIdx, drugIdx: di, field: "name", val: e.target.value })} />
                <input className="drug-input" type="number" value={d.dose} onChange={e => update("drugField", { procIdx, drugIdx: di, field: "dose", val: +e.target.value })} />
                <input className="drug-input" type="number" value={d.conc} onChange={e => update("drugField", { procIdx, drugIdx: di, field: "conc", val: +e.target.value })} />
                <input className="drug-input" type="number" value={d.bottleSize} onChange={e => update("drugField", { procIdx, drugIdx: di, field: "bottleSize", val: +e.target.value })} />
                <input className="drug-input" type="number" value={d.bottleCost} onChange={e => update("drugField", { procIdx, drugIdx: di, field: "bottleCost", val: +e.target.value })} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, textAlign: "right" }}>{r.volMl.toFixed(3)}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, textAlign: "right", color: "var(--amber)" }}>{fmt(r.deadCost)}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, textAlign: "right", fontWeight: 600 }}>{fmt(r.cost)}</span>
                <button className="btn danger-sm" onClick={() => update("removeDrug", { procIdx, drugIdx: di })}>✕</button>
              </div>
            );
          })}
          <div style={{ padding: "10px 15px", background: "var(--surface2)", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600 }}>
            <span>Total drug cost for {proc?.name} at {weight}kg</span>
            <span style={{ fontFamily: "var(--mono)" }}>{fmt(totals.cost)} cost · {fmt(totals.sell)} sell price</span>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Equipment & Financing ──────────────────────────────────────────────────────
function EquipmentPage({ state, update }) {
  const [selEquip, setSelEquip] = useState(0);
  const [payoffYears, setPayoffYears] = useState(5);
  const [calcForm, setCalcForm] = useState({ price: 60000, rate: 7.5, years: 5, deposit: 0 });
  const eq = state.equipment[selEquip];
  const totalEquipCost = state.equipment.reduce((a, e) => {
    const depr = e.price / (e.life || 1);
    const annualLoan = e.status === "loan" ? calcAnnualRepay(e.loanRepay || e.price, e.rate, 5) : 0;
    return a + depr + annualLoan + e.maintenance;
  }, 0);

  const payoffScenarios = [3, 5, 7, 10, 15].map(yrs => {
    if (!eq) return { yrs, annual: 0, perProc: 0 };
    const annual = calcAnnualRepay(eq.price, eq.rate || 0, yrs) + eq.maintenance;
    const perProc = annual / (eq.vol || 1);
    return { yrs, annual, perProc };
  });
  const chosen = payoffScenarios.find(s => s.yrs === payoffYears) || payoffScenarios[1];
  const progress = eq ? Math.min(100, ((eq.vol || 0) / (chosen.perProc > 0 ? chosen.annual / (eq.fee || 1) : 1)) * 100) : 0;

  return (
    <>
      <div className="topbar">
        <div className="topbar-left"><h1>Equipment & financing</h1><p>Loan calculator, depreciation, and payoff analysis per piece of equipment</p></div>
        <div className="topbar-actions">
          <button className="btn" onClick={() => update("addEquipment", { name: "New equipment", status: "owned", price: 10000, age: 0, life: 10, loanRepay: 0, maintenance: 500, rate: 0, fee: 100, cogs: 20, vol: 50 })}>+ Add equipment</button>
        </div>
      </div>
      <div className="content">
        <div className="card">
          <div className="card-header"><div className="card-title">🧮 Loan repayment calculator</div></div>
          <div className="padded grid4">
            {[["Purchase price ($)", "price"], ["Interest rate (%/yr)", "rate"], ["Loan term (years)", "years"], ["Deposit ($)", "deposit"]].map(([label, key]) => (
              <div className="field" key={key}><label>{label}</label><input className="input r" type="number" value={calcForm[key]} onChange={e => setCalcForm(p => ({ ...p, [key]: +e.target.value }))} /></div>
            ))}
          </div>
          <div style={{ padding: "10px 16px", background: "var(--surface2)", borderTop: "1px solid var(--border)", display: "flex", gap: 20, fontSize: 12 }}>
            <span>Monthly repayment: <strong className="mono">{fmt(calcAnnualRepay(calcForm.price - calcForm.deposit, calcForm.rate, calcForm.years) / 12)}</strong></span>
            <span>Annual cost: <strong className="mono">{fmt(calcAnnualRepay(calcForm.price - calcForm.deposit, calcForm.rate, calcForm.years))}</strong></span>
            <span>Total interest: <strong className="mono amber">{fmt(calcAnnualRepay(calcForm.price - calcForm.deposit, calcForm.rate, calcForm.years) * calcForm.years - (calcForm.price - calcForm.deposit))}</strong></span>
            <button className="btn sm primary" onClick={() => update("addEquipment", { name: "New equipment (loan)", status: "loan", price: calcForm.price, age: 0, life: calcForm.years + 5, loanRepay: calcForm.price - calcForm.deposit, maintenance: 500, rate: calcForm.rate, fee: 100, cogs: 20, vol: 50 })}>Add to register →</button>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">📋 Equipment register</div></div>
          <table className="tbl">
            <thead><tr><th>Equipment</th><th>Status</th><th className="r">Purchase price</th><th className="r">Age (yrs)</th><th className="r">Life (yrs)</th><th className="r">Wear & tear / yr</th><th className="r">Annual loan cost</th><th className="r">Maintenance / yr</th><th className="r">Total / yr</th><th></th></tr></thead>
            <tbody>
              {state.equipment.map((e, i) => {
                const depr = e.price / (e.life || 1);
                const annualLoan = e.status === "loan" ? calcAnnualRepay(e.loanRepay || e.price, e.rate, 5) : 0;
                const totalPerYr = depr + annualLoan + e.maintenance;
                return (
                  <tr key={i}>
                    <td><input value={e.name} onChange={ev => update("equipField", { i, field: "name", val: ev.target.value })} style={{ border: "none", background: "transparent", fontSize: 12, fontFamily: "inherit", color: "var(--text)", width: 140 }} /></td>
                    <td>
                      <select value={e.status} onChange={ev => update("equipField", { i, field: "status", val: ev.target.value })} style={{ fontSize: 11, border: "1px solid var(--border2)", borderRadius: 4, padding: "2px 5px", fontFamily: "inherit", background: "var(--surface)" }}>
                        <option value="owned">Owned</option>
                        <option value="loan">On loan</option>
                        <option value="leased">Leased</option>
                      </select>
                    </td>
                    <td className="r"><input type="number" value={e.price} onChange={ev => update("equipField", { i, field: "price", val: +ev.target.value })} style={{ width: 80, textAlign: "right", border: "1px solid var(--border2)", borderRadius: 4, padding: "2px 5px", fontSize: 11, fontFamily: "var(--mono)", background: "var(--surface)", color: "var(--text)" }} /></td>
                    <td className="r"><input type="number" value={e.age || 0} onChange={ev => update("equipField", { i, field: "age", val: +ev.target.value })} style={{ width: 45, textAlign: "right", border: "1px solid var(--border2)", borderRadius: 4, padding: "2px 5px", fontSize: 11, fontFamily: "var(--mono)", background: "var(--surface)", color: "var(--text)" }} /></td>
                    <td className="r"><input type="number" value={e.life || 10} onChange={ev => update("equipField", { i, field: "life", val: +ev.target.value })} style={{ width: 45, textAlign: "right", border: "1px solid var(--border2)", borderRadius: 4, padding: "2px 5px", fontSize: 11, fontFamily: "var(--mono)", background: "var(--surface)", color: "var(--text)" }} /></td>
                    <td className="r mono" style={{ color: "var(--amber)" }}>{fmt(depr)}</td>
                    <td className="r mono">{e.status === "loan" ? fmt(annualLoan) : "—"}</td>
                    <td className="r"><input type="number" value={e.maintenance} onChange={ev => update("equipField", { i, field: "maintenance", val: +ev.target.value })} style={{ width: 70, textAlign: "right", border: "1px solid var(--border2)", borderRadius: 4, padding: "2px 5px", fontSize: 11, fontFamily: "var(--mono)", background: "var(--surface)", color: "var(--text)" }} /></td>
                    <td className="r mono" style={{ fontWeight: 600 }}>{fmt(totalPerYr)}</td>
                    <td><button className="btn danger-sm" onClick={() => update("removeEquipment", i)}>✕</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="card-footer"><span>Total annual equipment cost: <strong>{fmt(totalEquipCost)}</strong></span></div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">📈 Payoff calculator</div>
            <div style={{ display: "flex", gap: 6 }}>
              {state.equipment.map((e, i) => (
                <button key={i} className={`payoff-tab${i === selEquip ? " active" : ""}`} onClick={() => setSelEquip(i)}>{e.name}</button>
              ))}
            </div>
          </div>
          {eq && (
            <>
              <div style={{ padding: "11px 16px", display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, borderBottom: "1px solid var(--border)" }}>
                <span>Current fee charged: <strong className="mono">{fmt(eq.fee)}</strong></span>
                <span>Procedures per year: <strong className="mono">{eq.vol}</strong></span>
                <span>Annual revenue from this machine: <strong className="mono green">{fmt(eq.fee * eq.vol)}</strong></span>
                <span>Wear & tear (depreciation): <strong className="mono amber">{fmt(eq.price / (eq.life || 1))}/yr</strong></span>
              </div>
              <div className="scenario-grid">
                {payoffScenarios.map(s => (
                  <div key={s.yrs} className={`scenario-card${s.yrs === payoffYears ? " active" : ""}`} onClick={() => setPayoffYears(s.yrs)}>
                    <div className="sy">{s.yrs} yr</div>
                    <div className="sl">Payoff</div>
                    <div className="sv">{fmt(s.annual)}/yr</div>
                    <div className="ss">{fmtI(Math.ceil(s.annual / (eq.fee || 1)))} procedures needed</div>
                  </div>
                ))}
              </div>
              <div style={{ padding: "11px 16px" }}>
                <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 4 }}>Current volume vs procedures needed ({payoffYears}-year payoff)</div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div className="progress-track" style={{ flex: 1 }}>
                    <div className="progress-fill" style={{ width: `${progress}%`, background: progress >= 100 ? "var(--g)" : progress >= 60 ? "var(--amber)" : "var(--red)" }} />
                  </div>
                  <span style={{ fontSize: 11, fontFamily: "var(--mono)", minWidth: 60 }}>{fmtI(eq.vol)} / {fmtI(Math.ceil(chosen.annual / (eq.fee || 1)))}</span>
                </div>
              </div>
              <div className="whatif-grid">
                <div className="whatif-card"><div className="whatif-label">Raise fee by $20</div><div className="whatif-val green">{fmtI(Math.ceil(chosen.annual / ((eq.fee || 1) + 20)))}</div><div className="whatif-sub">procedures needed</div></div>
                <div className="whatif-card"><div className="whatif-label">+50 procedures / yr</div><div className="whatif-val green">{fmt((eq.vol + 50) * eq.fee - chosen.annual)}</div><div className="whatif-sub">annual surplus</div></div>
                <div className="whatif-card"><div className="whatif-label">Break-even fee</div><div className="whatif-val amber">{fmt(chosen.annual / (eq.vol || 1))}</div><div className="whatif-sub">at current volume</div></div>
                <div className="whatif-card"><div className="whatif-label">Current surplus/deficit</div><div className={`whatif-val ${eq.vol * eq.fee > chosen.annual ? "green" : "red"}`}>{fmt(eq.vol * eq.fee - chosen.annual)}</div><div className="whatif-sub">this year</div></div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ── All Services Pricing ───────────────────────────────────────────────────────
function PricingPage({ state, update }) {
  const [activeTab, setActiveTab] = useState("Consultations");
  const [marginPct, setMarginPct] = useState(10);
  const [ohMode, setOhMode] = useState("time");
  const [expandedRow, setExpandedRow] = useState(null);
  const { ohPerEvent, isoPerMin } = state.computed;
  const tabs = ["Consultations", "Cat routine", "Dog routine", "Cat dental", "Dog dental"];

  const getConsultCalc = c => calcConsultCost(c, state.wages, ohPerEvent, state.procedures, state.consults, ohMode);
  const getProcCalc = p => calcProcCost(p, state.wages, ohPerEvent, isoPerMin, state.procedures, state.consults, ohMode);

  const renderServiceRows = (services, isProc) => services.map((s, idx) => {
    const calc = isProc ? getProcCalc(s) : getConsultCalc(s);
    const min = calc.minPriceInc;
    const recommended = min * (1 + marginPct / 100);
    const cur = s.current;
    const status = !cur ? ["No price set", "warn"] : cur < min ? ["Under cost", "bad"] : cur >= recommended ? ["On target", "ok"] : ["Below target", "warn"];
    const rowKey = (isProc ? "p" : "c") + idx;
    const isExpanded = expandedRow === rowKey;
    const vol = s.vol || 0;
    const annualRevAtMin = vol * min;
    const annualRevAtCur = vol * (cur || 0);
    const leakage = cur && cur < min ? (min - cur) * vol : 0;

    return [
      <tr key={rowKey} onClick={() => setExpandedRow(isExpanded ? null : rowKey)} style={{ cursor: "pointer" }}>
        <td>
          <div style={{ fontWeight: 500 }}>{s.name}</div>
          {s.vet2Mins > 0 && <div style={{ fontSize: 10, color: "var(--amber)" }}>⚠️ Requires second vet</div>}
        </td>
        <td className="r">
          <input type="range" min={0} max={500} step={5} value={vol} className="vol-slider" onClick={e => e.stopPropagation()} onChange={e => {
            if (isProc) update("procVol", { idx: state.procedures.indexOf(s), val: +e.target.value });
            else update("consultVol", { idx: state.consults.indexOf(s), val: +e.target.value });
          }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, minWidth: 30, display: "inline-block", textAlign: "right" }}>{vol}</span>
        </td>
        <td className="r mono">{fmt(calc.totalCostEx)}</td>
        <td className="r mono">{fmt(min)}</td>
        <td className="r mono green">{fmt(recommended)}</td>
        <td className="r" style={{ fontSize: 11, color: "var(--text3)" }}>{s.market}</td>
        <td className="r">
          <input type="number" value={cur || ""} placeholder="—" onClick={e => e.stopPropagation()} onChange={e => {
            const val = e.target.value ? +e.target.value : null;
            if (isProc) update("procPrice", { idx: state.procedures.indexOf(s), val });
            else update("consultPrice", { idx: state.consults.indexOf(s), val });
          }} style={{ width: 72, textAlign: "right", border: "1px solid var(--border2)", borderRadius: 4, padding: "2px 5px", fontSize: 11, fontFamily: "var(--mono)", background: "var(--surface)", color: "var(--text)" }} />
        </td>
        <td className="r mono" style={{ color: leakage > 0 ? "var(--red)" : "var(--text3)" }}>{leakage > 0 ? fmt(leakage) : "—"}</td>
        <td><Badge type={status[1]}>{status[0]}</Badge></td>
        <td style={{ fontSize: 11, color: "var(--text3)" }}>{isExpanded ? "▲" : "▼"}</td>
      </tr>,
      isExpanded && (
        <tr key={rowKey + "-expanded"} className="pricing-row-expanded">
          <td colSpan={10} style={{ padding: "12px 16px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: "var(--gt)" }}>Cost breakdown — {s.name}</div>
                <div className="breakdown-box">
                  {isProc ? (
                    <>
                      {calc.vetCost > 0 && <div className="breakdown-row"><span className="breakdown-label">Vet time ({s.vetMins} mins)</span><span className="breakdown-val">{fmt(calc.vetCost)}</span></div>}
                      {calc.nurseCost > 0 && <div className="breakdown-row"><span className="breakdown-label">Nurse time ({s.nurseMins} mins)</span><span className="breakdown-val">{fmt(calc.nurseCost)}</span></div>}
                      {calc.vet2Cost > 0 && <div className="breakdown-row"><span className="breakdown-label">2nd vet time ({s.vet2Mins} mins)</span><span className="breakdown-val amber">{fmt(calc.vet2Cost)}</span></div>}
                      {calc.hospCost > 0 && <div className="breakdown-row"><span className="breakdown-label">Hospitalisation ({s.hospMins} mins nurse)</span><span className="breakdown-val">{fmt(calc.hospCost)}</span></div>}
                      {calc.postOpCost > 0 && <div className="breakdown-row"><span className="breakdown-label">Post-op care ({s.postOpMins} mins nurse)</span><span className="breakdown-val">{fmt(calc.postOpCost)}</span></div>}
                      {calc.isoCost > 0 && <div className="breakdown-row"><span className="breakdown-label">Isoflurane ({s.isoMins} mins)</span><span className="breakdown-val">{fmt(calc.isoCost)}</span></div>}
                      {(s.drugs || []).map((d, di) => <div key={di} className="breakdown-row"><span className="breakdown-label">{d.name}</span><span className="breakdown-val">{fmt(d.cost)}</span></div>)}
                      <div className="breakdown-row"><span className="breakdown-label">Consumables ({CONSUMABLES[s.consumLevel]?.label})</span><span className="breakdown-val">{fmt(calc.consumCost)}</span></div>
                      <div className="breakdown-row"><span className="breakdown-label">Overhead allocation</span><span className="breakdown-val">{fmt(calc.ohAlloc)}</span></div>
                      <div className="breakdown-row"><span className="breakdown-label" style={{ fontWeight: 600 }}>Total cost (ex GST)</span><span className="breakdown-val" style={{ fontWeight: 600 }}>{fmt(calc.totalCostEx)}</span></div>
                      <div className="breakdown-row"><span className="breakdown-label" style={{ fontWeight: 600 }}>Min sell price (inc GST)</span><span className="breakdown-val green" style={{ fontWeight: 600 }}>{fmt(min)}</span></div>
                    </>
                  ) : (
                    <>
                      {calc.vetCost > 0 && <div className="breakdown-row"><span className="breakdown-label">Vet time ({s.vetMins} mins)</span><span className="breakdown-val">{fmt(calc.vetCost)}</span></div>}
                      {calc.nurseCost > 0 && <div className="breakdown-row"><span className="breakdown-label">Nurse time ({s.nurseMins} mins)</span><span className="breakdown-val">{fmt(calc.nurseCost)}</span></div>}
                      {calc.supportCost > 0 && <div className="breakdown-row"><span className="breakdown-label">Support staff ({s.supportMins} mins)</span><span className="breakdown-val">{fmt(calc.supportCost)}</span></div>}
                      {(s.extraItems || []).map((e, ei) => <div key={ei} className="breakdown-row"><span className="breakdown-label">{e.label}</span><span className="breakdown-val">{fmt(e.cost)}</span></div>)}
                      <div className="breakdown-row"><span className="breakdown-label">Consumables ({CONSUMABLES[s.consumLevel]?.label})</span><span className="breakdown-val">{fmt(calc.consumCost)}</span></div>
                      <div className="breakdown-row"><span className="breakdown-label">Overhead allocation</span><span className="breakdown-val">{fmt(calc.ohAlloc)}</span></div>
                      <div className="breakdown-row"><span className="breakdown-label" style={{ fontWeight: 600 }}>Total cost (ex GST)</span><span className="breakdown-val" style={{ fontWeight: 600 }}>{fmt(calc.totalCostEx)}</span></div>
                      <div className="breakdown-row"><span className="breakdown-label" style={{ fontWeight: 600 }}>Min sell price (inc GST)</span><span className="breakdown-val green" style={{ fontWeight: 600 }}>{fmt(min)}</span></div>
                    </>
                  )}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: "var(--gt)" }}>Revenue analysis at {vol} procedures/yr</div>
                <div className="breakdown-box">
                  <div className="breakdown-row"><span className="breakdown-label">Annual revenue at min price</span><span className="breakdown-val">{fmt(annualRevAtMin)}</span></div>
                  <div className="breakdown-row"><span className="breakdown-label">Annual revenue at {marginPct}% target</span><span className="breakdown-val green">{fmt(vol * recommended)}</span></div>
                  {cur && <div className="breakdown-row"><span className="breakdown-label">Annual revenue at your current price</span><span className="breakdown-val">{fmt(annualRevAtCur)}</span></div>}
                  {leakage > 0 && <div className="breakdown-row"><span className="breakdown-label">Annual revenue left on the table</span><span className="breakdown-val red">{fmt(leakage)}</span></div>}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )
    ];
  });

  const activeConsults = activeTab === "Consultations" ? state.consults : [];
  const activeProcs = activeTab !== "Consultations" ? state.procedures.filter(p => p.category === activeTab) : [];

  return (
    <>
      <div className="topbar">
        <div className="topbar-left"><h1>All services</h1><p>Live pricing with cost breakdowns — click any row to expand</p></div>
        <div className="topbar-actions">
          <div style={{ fontSize: 12, color: "var(--text2)", display: "flex", alignItems: "center", gap: 8 }}>
            <span>Overhead allocation:</span>
            <div className="toggle-group">
              <button className={`toggle-btn${ohMode === "event" ? " active" : ""}`} onClick={() => setOhMode("event")}>Per event</button>
              <button className={`toggle-btn${ohMode === "time" ? " active" : ""}`} onClick={() => setOhMode("time")}>Time-based</button>
            </div>
          </div>
        </div>
      </div>
      <div className="content">
        <div className="card" style={{ marginBottom: 13 }}>
          <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--text2)" }}>Margin target:</span>
            <input type="range" min={0} max={50} step={1} value={marginPct} onChange={e => setMarginPct(+e.target.value)} style={{ width: 140, accentColor: "var(--g)" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600, minWidth: 36 }}>{marginPct}%</span>
            <div style={{ display: "flex", gap: 6 }}>
              {[0, 10, 20, 30].map(p => <button key={p} className={`btn sm${marginPct === p ? " sel" : ""}`} onClick={() => setMarginPct(p)}>{p === 0 ? "Break-even" : `${p}% target`}</button>)}
            </div>
            {marginPct === 10 && <span style={{ fontSize: 11, color: "var(--gt)", background: "var(--gb)", padding: "2px 8px", borderRadius: 20 }}>Industry standard</span>}
          </div>
        </div>

        <div className="card">
          <div className="tab-bar">
            {tabs.map(t => <div key={t} className={`tab${activeTab === t ? " active" : ""}`} onClick={() => setActiveTab(t)}>{t}</div>)}
          </div>

          <table className="tbl">
            <thead>
              <tr>
                <th>Service</th>
                <th className="r">Vol/yr <span style={{ fontWeight: 400 }}>▲</span></th>
                <th className="r">Cost base</th>
                <th className="r">Min price (inc GST)</th>
                <th className="r">At {marginPct}% target</th>
                <th className="r">Market range</th>
                <th className="r">Your price</th>
                <th className="r">Annual leakage</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activeTab === "Consultations" ? renderServiceRows(state.consults, false) : renderServiceRows(state.procedures.filter(p => p.category === activeTab), true)}
            </tbody>
          </table>

          <div style={{ padding: "9px 16px", background: "var(--surface2)", borderTop: "1px solid var(--border)", display: "flex", gap: 12 }}>
            <button className="btn sm" onClick={() => {
              const newProc = { name: "New procedure", category: activeTab === "Consultations" ? "Cat routine" : activeTab, vetMins: 30, nurseMins: 30, vet2Mins: 0, hospMins: 60, postOpMins: 15, isoMins: 30, consumLevel: 2, drugs: [], current: null, market: "—", vol: 20 };
              update("addServiceRow", newProc);
            }}>+ Add procedure to {activeTab}</button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Locum Planner ──────────────────────────────────────────────────────────────
function LocumPage({ state, update }) {
  const totalEvents = Object.values(state.volumes).reduce((a, v) => a + v, 0);
  const { ohPerEvent } = state.computed;
  const locumDays = state.locumPeriods.reduce((a, p) => a + p.days, 0);
  const locumCost = locumDays * 8 * state.wages.locum;
  const vetCostSame = locumDays * 8 * state.wages.vet;
  const locumPremium = locumCost - vetCostSame;
  const ohWithLocum = (ohPerEvent * totalEvents + locumPremium) / (totalEvents || 1);

  return (
    <>
      <div className="topbar">
        <div className="topbar-left"><h1>Locum planner</h1><p>Plan and cost locum cover periods throughout the year</p></div>
      </div>
      <div className="content">
        <div className="metrics-row">
          <MetricCard label="Employed vet rate" value={`${fmt(state.wages.vet)}/hr`} sub="From wages & overheads" />
          <MetricCard label="Locum rate" value={`${fmt(state.wages.locum)}/hr`} sub="From wages & overheads" />
          <MetricCard label="Locum premium" value={`${fmt(state.wages.locum - state.wages.vet)}/hr`} sub="Extra cost over employed vet" color="amber" />
          <MetricCard label="Total locum days planned" value={`${locumDays} days`} sub={`${fmt(locumCost)} total locum cost`} color="amber" />
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">📅 Planned locum periods</div>
            <button className="btn sm" onClick={() => update("addLocum")}>+ Add period</button>
          </div>
          <table className="tbl">
            <thead><tr><th>Reason</th><th>Month / period</th><th className="r">Days</th><th>Type</th><th className="r">Locum cost</th><th className="r">Employed cost</th><th className="r">Premium</th><th></th></tr></thead>
            <tbody>
              {state.locumPeriods.map((p, i) => {
                const lCost = p.days * 8 * state.wages.locum;
                const eCost = p.days * 8 * state.wages.vet;
                return (
                  <tr key={i}>
                    <td><input value={p.reason} onChange={e => update("locumField", { i, field: "reason", val: e.target.value })} style={{ border: "none", background: "transparent", fontSize: 12, fontFamily: "inherit", width: "100%" }} /></td>
                    <td><input value={p.month} onChange={e => update("locumField", { i, field: "month", val: e.target.value })} style={{ border: "none", background: "transparent", fontSize: 12, fontFamily: "inherit", width: "100%" }} /></td>
                    <td className="r"><input type="number" value={p.days} onChange={e => update("locumField", { i, field: "days", val: +e.target.value })} style={{ width: 50, textAlign: "right", border: "1px solid var(--border2)", borderRadius: 4, padding: "2px 5px", fontSize: 11, fontFamily: "var(--mono)" }} /></td>
                    <td><span className="badge info">{p.type}</span></td>
                    <td className="r mono amber">{fmt(lCost)}</td>
                    <td className="r mono">{fmt(eCost)}</td>
                    <td className="r mono red">{fmt(lCost - eCost)}</td>
                    <td><button className="btn danger-sm" onClick={() => update("removeLocum", i)}>✕</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="card-footer">
            <span>Total locum premium (extra cost over employed vet): <strong className="red">{fmt(locumPremium)}</strong></span>
            <span>OH per event with locum included: <strong>{fmt(ohWithLocum)}</strong> vs {fmt(ohPerEvent)} without</span>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Cost Disruption Tracker ────────────────────────────────────────────────────
function DisruptionPage({ state, update }) {
  const [contingencyMode, setContingencyMode] = useState("pct");
  const [contingencyPct, setContingencyPct] = useState(state.contingencyPct || 4);
  const [contingencyFixed, setContingencyFixed] = useState(15000);
  const { totalCostBase } = state.computed;
  const buffer = contingencyMode === "pct" ? totalCostBase * contingencyPct / 100 : contingencyFixed;
  const totalSpend = [...state.disruptions.map(d => d.extraSpend), ...state.repairs.map(r => r.cost)].reduce((a, v) => a + v, 0);
  const remaining = buffer - totalSpend;

  return (
    <>
      <div className="topbar">
        <div className="topbar-left"><h1>Cost disruption tracker</h1><p>Backorder costs, equipment failures, and your contingency buffer</p></div>
      </div>
      <div className="content">
        <div className="card">
          <div className="card-header">
            <div className="card-title">🛡️ Contingency buffer</div>
            <div className="toggle-group">
              <button className={`toggle-btn${contingencyMode === "pct" ? " active" : ""}`} onClick={() => setContingencyMode("pct")}>% of cost base</button>
              <button className={`toggle-btn${contingencyMode === "fixed" ? " active" : ""}`} onClick={() => setContingencyMode("fixed")}>Fixed amount</button>
            </div>
          </div>
          <div className="padded grid4">
            {contingencyMode === "pct" ? (
              <>
                <div className="field"><label>Buffer % of cost base</label><input className="input r" type="number" value={contingencyPct} onChange={e => { setContingencyPct(+e.target.value); update("contingency", +e.target.value); }} /></div>
                <div className="field"><label>Buffer amount (calculated)</label><input className="input r" readOnly value={fmt(buffer)} style={{ background: "var(--gb)", color: "var(--gt)", fontWeight: 500 }} /></div>
              </>
            ) : (
              <div className="field"><label>Fixed buffer amount ($)</label><input className="input r" type="number" value={contingencyFixed} onChange={e => setContingencyFixed(+e.target.value)} /></div>
            )}
            <div className="field"><label>Total disruption spend YTD</label><input className="input r" readOnly value={fmt(totalSpend)} style={{ background: remaining < 0 ? "#FEE2E2" : "var(--surface2)", color: remaining < 0 ? "var(--red)" : "var(--text)" }} /></div>
            <div className="field"><label>Buffer remaining</label><input className="input r" readOnly value={fmt(remaining)} style={{ background: remaining >= 0 ? "var(--gb)" : "#FEE2E2", color: remaining >= 0 ? "var(--gt)" : "var(--red)", fontWeight: 500 }} /></div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">📦 Backorder & supply disruptions</div>
            <button className="btn sm" onClick={() => update("addDisruption")}>+ Log disruption</button>
          </div>
          <table className="tbl">
            <thead><tr><th>Item</th><th>Normal cost</th><th>Alternative cost</th><th>Duration</th><th className="r">Extra spend</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {state.disruptions.map((d, i) => (
                <tr key={i}>
                  <td><input value={d.item} onChange={e => update("disruptionField", { i, field: "item", val: e.target.value })} style={{ border: "none", background: "transparent", fontSize: 12, fontFamily: "inherit", width: "100%" }} /></td>
                  <td style={{ fontSize: 11, color: "var(--text3)" }}>{d.normalCost}</td>
                  <td style={{ fontSize: 11, color: "var(--amber)" }}>{d.altCost}</td>
                  <td style={{ fontSize: 11 }}>{d.duration}</td>
                  <td className="r mono amber">{fmt(d.extraSpend)}</td>
                  <td><Badge type={d.status === "Active" ? "bad" : d.status === "Resolved" ? "ok" : "warn"}>{d.status}</Badge></td>
                  <td><button className="btn danger-sm" onClick={() => update("removeDisruption", i)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">🔧 Emergency equipment repairs</div>
            <button className="btn sm" onClick={() => update("addRepair")}>+ Log repair</button>
          </div>
          <table className="tbl">
            <thead><tr><th>Equipment</th><th>Date</th><th className="r">Cost</th><th>Downtime</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {state.repairs.map((r, i) => (
                <tr key={i}>
                  <td>{r.equipment}</td>
                  <td style={{ fontSize: 11, color: "var(--text3)" }}>{r.date}</td>
                  <td className="r mono red">{fmt(r.cost)}</td>
                  <td style={{ fontSize: 11 }}>{r.downtime}</td>
                  <td style={{ fontSize: 11, color: "var(--text3)" }}>{r.notes}</td>
                  <td><button className="btn danger-sm" onClick={() => update("removeRepair", i)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── Practice Health ────────────────────────────────────────────────────────────
function PracticeHealthPage({ state }) {
  const [vetUtil, setVetUtil] = useState(65);
  const [nurseUtil, setNurseUtil] = useState(70);
  const vetFTE = 4.6;
  const nurseFTE = 7;
  const hoursPerYear = 46 * 40;
  const billableHoursVet = vetFTE * hoursPerYear * (vetUtil / 100);
  const revenuePerVetHour = 550000 / (vetFTE * hoursPerYear * (vetUtil / 100));
  const vetRevGap = vetFTE * hoursPerYear * (0.80 - vetUtil / 100) * revenuePerVetHour;
  const nurseRevGap = nurseFTE * hoursPerYear * (0.80 - nurseUtil / 100) * revenuePerVetHour * 0.4;

  const benchmarks = [
    { metric: "Revenue per vet FTE", yours: 550000 / vetFTE, benchmark: "NZ$420,000–500,000", status: 550000 / vetFTE > 420000 ? "ok" : "bad" },
    { metric: "EBITDA margin", yours: "~14%", benchmark: "10–18% (healthy)", status: "ok" },
    { metric: "Vet utilisation", yours: `${vetUtil}%`, benchmark: "75–85% (optimal)", status: vetUtil >= 75 ? "ok" : vetUtil >= 60 ? "warn" : "bad" },
    { metric: "Nurse utilisation", yours: `${nurseUtil}%`, benchmark: "70–80% (optimal)", status: nurseUtil >= 70 ? "ok" : nurseUtil >= 55 ? "warn" : "bad" },
    { metric: "Revenue per billable hour", yours: fmt(revenuePerVetHour), benchmark: "NZ$180–260/hr", status: revenuePerVetHour >= 180 ? "ok" : "warn" },
  ];

  return (
    <>
      <div className="topbar">
        <div className="topbar-left"><h1>Practice health</h1><p>Utilisation rates, revenue benchmarks, and capacity gaps · <span style={{ color: "var(--g)", fontWeight: 500 }}>V2</span></p></div>
      </div>
      <div className="content">
        <div className="metrics-row">
          <MetricCard label="Revenue per vet FTE" value={fmtK(550000 / vetFTE)} sub={`Based on 4.6 FTE`} color="green" />
          <MetricCard label="Revenue per billable hour" value={fmt(revenuePerVetHour)} sub="At current utilisation" />
          <MetricCard label="Vet utilisation gap" value={vetUtil < 80 ? fmtK(vetRevGap) : "$0"} sub={vetUtil < 80 ? "Revenue opportunity at 80%" : "At or above 80% — great!"} color={vetUtil < 80 ? "amber" : "green"} />
          <MetricCard label="Nurse utilisation gap" value={nurseUtil < 80 ? fmtK(nurseRevGap) : "$0"} sub={nurseUtil < 80 ? "Revenue opportunity at 80%" : "At or above 80% — great!"} color={nurseUtil < 80 ? "amber" : "green"} />
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">📊 Utilisation — drag to update</div></div>
          <div style={{ padding: "14px 16px" }}>
            {[["Vet utilisation", vetUtil, setVetUtil, "var(--g)"], ["Nurse utilisation", nurseUtil, setNurseUtil, "#185FA5"]].map(([label, val, setter, color]) => (
              <div key={label} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                  <span style={{ fontWeight: 500 }}>{label}</span>
                  <span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>{val}%</span>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div className="util-bar">
                    <div className="util-fill" style={{ width: `${val}%`, background: color }} />
                  </div>
                  <input type="range" min={40} max={100} value={val} onChange={e => setter(+e.target.value)} style={{ width: 120, accentColor: color }} />
                </div>
                <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>
                  {val < 75 ? `💡 Raising to 75% could add ${fmtK(label.includes("Vet") ? vetRevGap : nurseRevGap)} in annual revenue` : "✓ Within optimal range"}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">🏆 NZ companion animal practice benchmarks</div></div>
          <table className="tbl">
            <thead><tr><th>Metric</th><th className="r">Your practice</th><th className="r">NZ benchmark</th><th>Status</th></tr></thead>
            <tbody>
              {benchmarks.map(b => (
                <tr key={b.metric}>
                  <td>{b.metric}</td>
                  <td className="r mono" style={{ fontWeight: 600 }}>{typeof b.yours === "number" ? fmt(b.yours) : b.yours}</td>
                  <td className="r" style={{ fontSize: 11, color: "var(--text3)" }}>{b.benchmark}</td>
                  <td><Badge type={b.status}>{b.status === "ok" ? "On track" : b.status === "warn" ? "Watch" : "Below target"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="card-footer"><span style={{ fontSize: 10, color: "var(--text3)" }}>NZ benchmarks sourced from NZVA and veterinary industry reports. Updated annually.</span></div>
        </div>
      </div>
    </>
  );
}

// ── EBITDA Simulator ───────────────────────────────────────────────────────────
function SimulatorPage({ state }) {
  const [consultFeeIncrease, setConsultFeeIncrease] = useState(0);
  const [surgeryFeeIncrease, setSurgeryFeeIncrease] = useState(0);
  const [vetUtilIncrease, setVetUtilIncrease] = useState(0);
  const [overheadReduction, setOverheadReduction] = useState(0);
  const [nurseConsults, setNurseConsults] = useState(0);
  const { totalCostBase } = state.computed;
  const baseRevenue = 550000;
  const baseEbitda = baseRevenue * 0.14;
  const consultRevImpact = consultFeeIncrease * (state.volumes.consults || 3000);
  const surgeryRevImpact = surgeryFeeIncrease * (state.volumes.routine || 500);
  const utilImpact = vetUtilIncrease * 1800;
  const ohImpact = totalCostBase * overheadReduction / 100;
  const nurseConsultImpact = nurseConsults * 45;
  const totalImpact = consultRevImpact + surgeryRevImpact + utilImpact + ohImpact + nurseConsultImpact;
  const newRevenue = baseRevenue + consultRevImpact + surgeryRevImpact + utilImpact + nurseConsultImpact;
  const newEbitda = baseEbitda + totalImpact;
  const ebitdaMargin = (newEbitda / newRevenue * 100).toFixed(1);

  const sliders = [
    ["Increase consult fee by ($/consult)", consultFeeIncrease, setConsultFeeIncrease, 0, 30, 1, `${fmt(consultRevImpact)} revenue`],
    ["Increase surgery fee by ($/procedure)", surgeryFeeIncrease, setSurgeryFeeIncrease, 0, 100, 5, `${fmt(surgeryRevImpact)} revenue`],
    ["Improve vet utilisation by (%)", vetUtilIncrease, setVetUtilIncrease, 0, 20, 1, `${fmt(utilImpact)} revenue`],
    ["Add nurse consultations / yr", nurseConsults, setNurseConsults, 0, 500, 10, `${fmt(nurseConsultImpact)} revenue`],
    ["Reduce overheads by (%)", overheadReduction, setOverheadReduction, 0, 15, 0.5, `${fmt(ohImpact)} savings`],
  ];

  return (
    <>
      <div className="topbar">
        <div className="topbar-left"><h1>EBITDA simulator</h1><p>Model the financial impact of pricing and operational changes · <span style={{ color: "var(--g)", fontWeight: 500 }}>V2</span></p></div>
        <div className="topbar-actions"><button className="btn" onClick={() => { setConsultFeeIncrease(0); setSurgeryFeeIncrease(0); setVetUtilIncrease(0); setOverheadReduction(0); setNurseConsults(0); }}>Reset</button></div>
      </div>
      <div className="content">
        <div className="metrics-row">
          <MetricCard label="Base revenue" value={fmtK(baseRevenue)} sub="Current year estimate" />
          <MetricCard label="Projected revenue" value={fmtK(newRevenue)} sub={totalImpact > 0 ? `+${fmtK(totalImpact)} from changes` : "No changes yet"} color={totalImpact > 0 ? "green" : ""} />
          <MetricCard label="Projected EBITDA" value={fmtK(newEbitda)} sub={`${ebitdaMargin}% margin`} color={newEbitda > baseEbitda ? "green" : ""} />
          <MetricCard label="EBITDA improvement" value={totalImpact >= 0 ? "+" + fmtK(totalImpact) : fmtK(totalImpact)} sub="From all changes combined" color={totalImpact > 0 ? "green" : totalImpact < 0 ? "red" : ""} />
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">🎛️ Adjust the levers</div></div>
          <div style={{ padding: "14px 16px" }}>
            {sliders.map(([label, val, setter, min, max, step, impact]) => (
              <div key={label} style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                  <span style={{ fontWeight: 500 }}>{label}</span>
                  <span style={{ fontFamily: "var(--mono)", fontWeight: 600, color: "var(--g)" }}>{label.includes("fee") || label.includes("consultations") ? (label.includes("fee") ? `+${fmt(val)}` : `+${val}`) : label.includes("Reduce") ? `${val}%` : `+${val}%`}</span>
                </div>
                <input type="range" min={min} max={max} step={step} value={val} onChange={e => setter(+e.target.value)} className="sim-slider" />
                <div style={{ fontSize: 10, color: "var(--gt)", background: "var(--gb)", borderRadius: 4, padding: "2px 7px", display: "inline-block", marginTop: 2 }}>Impact: {impact}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">📊 Impact summary</div></div>
          <table className="tbl">
            <thead><tr><th>Change</th><th className="r">Revenue impact</th><th className="r">EBITDA impact</th></tr></thead>
            <tbody>
              <tr><td>Consult fee increase of {fmt(consultFeeIncrease)}</td><td className="r mono green">{fmt(consultRevImpact)}</td><td className="r mono green">{fmt(consultRevImpact)}</td></tr>
              <tr><td>Surgery fee increase of {fmt(surgeryFeeIncrease)}</td><td className="r mono green">{fmt(surgeryRevImpact)}</td><td className="r mono green">{fmt(surgeryRevImpact)}</td></tr>
              <tr><td>Vet utilisation +{vetUtilIncrease}%</td><td className="r mono green">{fmt(utilImpact)}</td><td className="r mono green">{fmt(utilImpact)}</td></tr>
              <tr><td>Additional nurse consultations ({nurseConsults})</td><td className="r mono green">{fmt(nurseConsultImpact)}</td><td className="r mono green">{fmt(nurseConsultImpact)}</td></tr>
              <tr><td>Overhead reduction of {overheadReduction}%</td><td className="r mono">—</td><td className="r mono green">{fmt(ohImpact)}</td></tr>
              <tr className="total-row"><td>Total impact</td><td className="r mono green">{fmt(consultRevImpact + surgeryRevImpact + utilImpact + nurseConsultImpact)}</td><td className="r mono green">{fmt(totalImpact)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── P&L Report ─────────────────────────────────────────────────────────────────
function PLPage({ state }) {
  const [period, setPeriod] = useState("annual");
  const [taxRate, setTaxRate] = useState(0.28);
  const div = period === "annual" ? 1 : period === "quarterly" ? 4 : 12;
  const f = v => fmt(v / div);

  const consultIncome = state.consults.reduce((a, c) => a + (c.current || 0) * (c.vol || 0), 0);
  const procedureIncome = state.procedures.reduce((a, p) => a + (p.current || 0) * (p.vol || 0), 0);
  const otherIncomeTotal = state.otherIncome.reduce((a, r) => a + r.annualRev, 0);
  const totalIncomeInc = consultIncome + procedureIncome + otherIncomeTotal;
  const totalIncomeEx = totalIncomeInc / GST;
  const directCosts = [...state.consults, ...state.procedures].reduce((a, s) => {
    const drugCost = (s.drugs || []).reduce((da, d) => da + d.cost, 0);
    const consumCost = CONSUMABLES[s.consumLevel]?.cost || 0;
    return a + (drugCost + consumCost) * (s.vol || 0);
  }, 0);
  const grossProfit = totalIncomeEx - directCosts;
  const baseOH = state.overheads.reduce((a, o) => a + (parseFloat(o.value) || 0), 0);
  const totalDepreciation = state.equipment.reduce((a, e) => a + e.price / (e.life || 1), 0);
  const totalLoanInterest = state.equipment.filter(e => e.status === "loan").reduce((a, e) => a + (calcAnnualRepay(e.loanRepay || e.price, e.rate, 5) - (e.loanRepay || e.price) / 5), 0);
  const totalMaintenance = state.equipment.reduce((a, e) => a + e.maintenance, 0);
  const locumDays = state.locumPeriods.reduce((a, p) => a + p.days, 0);
  const locumPremium = locumDays * 8 * (state.wages.locum - state.wages.vet);
  const ebitda = grossProfit - baseOH - locumPremium;
  const ebit = ebitda - totalDepreciation;
  const ebt = ebit - totalLoanInterest;
  const profitBeforeTax = ebt;
  const taxAmount = Math.max(0, profitBeforeTax * taxRate);
  const takeHome = profitBeforeTax - taxAmount;

  return (
    <>
      <div className="topbar">
        <div className="topbar-left"><h1>P&L report</h1><p>Profit & loss based on your current pricing and overheads</p></div>
        <div className="topbar-actions">
          <div className="toggle-group">
            {["annual", "quarterly", "monthly"].map(p => <button key={p} className={`toggle-btn${period === p ? " active" : ""}`} onClick={() => setPeriod(p)}>{p.charAt(0).toUpperCase() + p.slice(1)}</button>)}
          </div>
          <button className="btn"><Icon d={ICONS.export} /> Export for accountant</button>
        </div>
      </div>
      <div className="content">
        <div className="card">
          <div className="pl-section">Income</div>
          <table className="tbl">
            <tbody>
              <tr><td>Consultations</td><td className="r mono">{f(consultIncome / GST)}</td></tr>
              <tr><td>Routine procedures (surgery & dentals)</td><td className="r mono">{f(procedureIncome / GST)}</td></tr>
              <tr><td>Other income (imaging, retail, boarding etc.)</td><td className="r mono">{f(otherIncomeTotal / GST)}</td></tr>
              <tr className="total-row"><td>Total income (ex GST)</td><td className="r mono">{f(totalIncomeEx)}</td></tr>
            </tbody>
          </table>

          <div className="pl-section">Cost of goods sold (COGS)</div>
          <table className="tbl">
            <tbody>
              <tr><td>Drugs & consumables</td><td className="r mono red">{f(-directCosts)}</td></tr>
              <tr className="total-row"><td>Gross profit</td><td className="r mono green">{f(grossProfit)}</td></tr>
            </tbody>
          </table>

          <div className="pl-section">Operating expenses</div>
          <table className="tbl">
            <tbody>
              <tr><td>Wages & all overheads</td><td className="r mono red">{f(-baseOH)}</td></tr>
              <tr><td>Locum premium (extra cost over employed vet)</td><td className="r mono red">{f(-locumPremium)}</td></tr>
              <tr className="total-row"><td>EBITDA <span className="pl-tooltip">(Earnings before interest, tax, depreciation)</span></td><td className={`r mono ${ebitda >= 0 ? "green" : "red"}`}>{f(ebitda)}</td></tr>
            </tbody>
          </table>

          <div className="pl-section">Equipment costs</div>
          <table className="tbl">
            <tbody>
              <tr><td>Equipment wear & tear <span className="pl-tooltip">(depreciation — cost of assets reducing in value)</span></td><td className="r mono amber">{f(-totalDepreciation)}</td></tr>
              <tr className="total-row"><td>EBIT <span className="pl-tooltip">(Earnings before interest & tax)</span></td><td className={`r mono ${ebit >= 0 ? "green" : "red"}`}>{f(ebit)}</td></tr>
              <tr><td>Loan interest</td><td className="r mono red">{f(-totalLoanInterest)}</td></tr>
              <tr><td>Equipment maintenance</td><td className="r mono red">{f(-totalMaintenance)}</td></tr>
              <tr className="total-row"><td>Profit before tax</td><td className={`r mono ${ebt >= 0 ? "green" : "red"}`}>{f(profitBeforeTax)}</td></tr>
            </tbody>
          </table>
        </div>

        <div className="tax-box">
          <div className="tax-title">🧮 IRD tax estimate</div>
          <div className="tax-row">
            <span>Business structure</span>
            <span>
              <select value={taxRate} onChange={e => setTaxRate(+e.target.value)} style={{ border: "none", background: "transparent", fontSize: 12, color: "var(--blue)", fontFamily: "inherit" }}>
                <option value={0.28}>Company (28%)</option>
                <option value={0.33}>Sole trader top rate (33%)</option>
                <option value={0.39}>Sole trader 39% rate</option>
              </select>
            </span>
          </div>
          <div className="tax-row"><span>Profit before tax</span><span className="mono">{f(profitBeforeTax)}</span></div>
          <div className="tax-row"><span>Estimated tax payable</span><span className="mono amber">{f(taxAmount)}</span></div>
          <div className="tax-row"><span>Estimated take-home surplus</span><span className="mono green">{f(takeHome)}</span></div>
          <div style={{ fontSize: 10, color: "var(--blue)", marginTop: 7 }}>This is an estimate only. Talk to your accountant for accurate tax advice.</div>
        </div>
      </div>
    </>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("dashboard");
  const [state, setState] = useState({
    wages: initialWages,
    overheads: initialOverheads,
    volumes: initialVolumes,
    iso: initialIso,
    consults: initialConsults,
    procedures: initialProcedures,
    drugProtocols: initialDrugProtocols,
    equipment: initialEquipment,
    otherIncome: initialOtherIncome,
    locumPeriods: initialLocumPeriods,
    disruptions: initialDisruptions,
    repairs: initialRepairs,
    contingencyPct: 4,
  });

  const computed = useMemo(() => {
    const baseOH = state.overheads.reduce((a, o) => a + (parseFloat(o.value) || 0), 0);
    const equipTotal = state.equipment.reduce((a, e) => {
      const depr = e.price / (e.life || 1);
      const annualLoan = e.status === "loan" ? calcAnnualRepay(e.loanRepay || e.price, e.rate, 5) : 0;
      return a + depr + annualLoan + e.maintenance;
    }, 0);
    const contingency = baseOH * state.contingencyPct / 100;
    const totalCostBase = baseOH + equipTotal + contingency;
    const totalEvents = Object.values(state.volumes).reduce((a, v) => a + v, 0);
    const ohPerEvent = totalEvents > 0 ? totalCostBase / totalEvents : 0;
    const isoPerMin = state.iso.costPerWeek / 7 / 8 / 60;
    return { baseOH, equipTotal, contingency, totalCostBase, ohPerEvent, isoPerMin };
  }, [state]);

  const consultsWithPrices = useMemo(() =>
    state.consults.map(c => ({ ...c, minPriceInc: calcConsultCost(c, state.wages, computed.ohPerEvent, state.procedures, state.consults, "time").minPriceInc })),
    [state.consults, state.wages, computed.ohPerEvent, state.procedures]);

  const proceduresWithPrices = useMemo(() =>
    state.procedures.map(p => ({ ...p, minPriceInc: calcProcCost(p, state.wages, computed.ohPerEvent, computed.isoPerMin, state.procedures, state.consults, "time").minPriceInc })),
    [state.procedures, state.wages, computed.ohPerEvent, computed.isoPerMin, state.consults]);

  const fullState = { ...state, computed, consults: consultsWithPrices, procedures: proceduresWithPrices };

  const update = useCallback((type, payload) => {
    setState(prev => {
      if (type === "wage") return { ...prev, wages: { ...prev.wages, [payload.key]: payload.val } };
      if (type === "overhead") { const oh = [...prev.overheads]; oh[payload.i] = { ...oh[payload.i], [payload.field]: payload.val }; return { ...prev, overheads: oh }; }
      if (type === "addOverhead") return { ...prev, overheads: [...prev.overheads, { label: "New overhead", value: 0, category: "Other" }] };
      if (type === "volume") return { ...prev, volumes: { ...prev.volumes, [payload.key]: payload.val } };
      if (type === "iso") return { ...prev, iso: { costPerWeek: payload.val } };
      if (type === "contingency") return { ...prev, contingencyPct: payload };
      if (type === "drugField") { const dp = JSON.parse(JSON.stringify(prev.drugProtocols)); dp[payload.procIdx].drugs[payload.drugIdx][payload.field] = payload.val; return { ...prev, drugProtocols: dp }; }
      if (type === "addDrug") { const dp = JSON.parse(JSON.stringify(prev.drugProtocols)); dp[payload].drugs.push({ name: "New drug", dose: 0.1, conc: 10, bottleSize: 10, bottleCost: 5.00 }); return { ...prev, drugProtocols: dp }; }
      if (type === "removeDrug") { const dp = JSON.parse(JSON.stringify(prev.drugProtocols)); dp[payload.procIdx].drugs.splice(payload.drugIdx, 1); return { ...prev, drugProtocols: dp }; }
      if (type === "addProcedure") return { ...prev, drugProtocols: [...prev.drugProtocols, { name: "New procedure", drugs: [] }] };
      if (type === "equipField") { const eq = JSON.parse(JSON.stringify(prev.equipment)); eq[payload.i][payload.field] = payload.val; return { ...prev, equipment: eq }; }
      if (type === "addEquipment") return { ...prev, equipment: [...prev.equipment, payload] };
      if (type === "removeEquipment") return { ...prev, equipment: prev.equipment.filter((_, i) => i !== payload) };
      if (type === "otherIncomeField") { const oi = JSON.parse(JSON.stringify(prev.otherIncome)); oi[payload.i][payload.field] = payload.val; return { ...prev, otherIncome: oi }; }
      if (type === "addOtherIncome") return { ...prev, otherIncome: [...prev.otherIncome, { category: "New income stream", annualRev: 0, margin: 50 }] };
      if (type === "removeOtherIncome") return { ...prev, otherIncome: prev.otherIncome.filter((_, i) => i !== payload) };
      if (type === "consultPrice") { const c = [...prev.consults]; c[payload.idx] = { ...c[payload.idx], current: payload.val }; return { ...prev, consults: c }; }
      if (type === "procPrice") { const p = [...prev.procedures]; p[payload.idx] = { ...p[payload.idx], current: payload.val }; return { ...prev, procedures: p }; }
      if (type === "consultVol") { const c = [...prev.consults]; c[payload.idx] = { ...c[payload.idx], vol: payload.val }; return { ...prev, consults: c }; }
      if (type === "procVol") { const p = [...prev.procedures]; p[payload.idx] = { ...p[payload.idx], vol: payload.val }; return { ...prev, procedures: p }; }
      if (type === "addServiceRow") return { ...prev, procedures: [...prev.procedures, payload] };
      if (type === "locumField") { const lp = JSON.parse(JSON.stringify(prev.locumPeriods)); lp[payload.i][payload.field] = payload.val; return { ...prev, locumPeriods: lp }; }
      if (type === "addLocum") return { ...prev, locumPeriods: [...prev.locumPeriods, { reason: "New period", month: "TBD", days: 5, type: "Planned" }] };
      if (type === "removeLocum") return { ...prev, locumPeriods: prev.locumPeriods.filter((_, i) => i !== payload) };
      if (type === "disruptionField") { const d = JSON.parse(JSON.stringify(prev.disruptions)); d[payload.i][payload.field] = payload.val; return { ...prev, disruptions: d }; }
      if (type === "addDisruption") return { ...prev, disruptions: [...prev.disruptions, { item: "New disruption", normalCost: "—", altCost: "—", duration: "Ongoing", extraSpend: 0, status: "Active" }] };
      if (type === "removeDisruption") return { ...prev, disruptions: prev.disruptions.filter((_, i) => i !== payload) };
      if (type === "addRepair") return { ...prev, repairs: [...prev.repairs, { equipment: "Equipment name", date: "Jun 2026", cost: 0, downtime: "—", notes: "—" }] };
      if (type === "removeRepair") return { ...prev, repairs: prev.repairs.filter((_, i) => i !== payload) };
      return prev;
    });
  }, []);

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: ICONS.dashboard, section: "Overview" },
    { id: "overheads", label: "Wages & overheads", icon: ICONS.overheads, section: "Inputs" },
    { id: "other-income", label: "Other income", icon: ICONS.income },
    { id: "drugs", label: "Drug protocol builder", icon: ICONS.drugs, section: "Clinical" },
    { id: "equipment", label: "Equipment & financing", icon: ICONS.equip },
    { id: "locum", label: "Locum planner", icon: ICONS.locum },
    { id: "disruption", label: "Cost disruption tracker", icon: ICONS.disruption },
    { id: "pricing", label: "All services", icon: ICONS.pricing, section: "Pricing" },
    { id: "pl", label: "P&L report", icon: ICONS.pl, section: "Reports" },
    { id: "health", label: "Practice health", icon: ICONS.health, section: "Intelligence", badge: "V2" },
    { id: "simulator", label: "EBITDA simulator", icon: ICONS.simulator, badge: "V2" },
  ];

  const pages = {
    dashboard: Dashboard,
    overheads: OverheadsPage,
    "other-income": OtherIncomePage,
    drugs: DrugProtocolPage,
    equipment: EquipmentPage,
    locum: LocumPage,
    disruption: DisruptionPage,
    pricing: PricingPage,
    pl: PLPage,
    health: PracticeHealthPage,
    simulator: SimulatorPage,
  };
  const PageComponent = pages[page] || Dashboard;

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <div className="sidebar">
          <div className="logo-area">
            <div className="logo-mark">
              <div className="logo-dot">
                <svg viewBox="0 0 24 24"><path d="M12 21.593c-5.63-5.539-11-10.297-11-14.402 0-3.791 3.068-5.191 5.281-5.191 1.312 0 4.151.501 5.719 4.457 1.59-3.968 4.464-4.447 5.726-4.447 2.54 0 5.274 1.621 5.274 5.181 0 4.069-5.136 8.625-11 14.402z" /></svg>
              </div>
              <span className="logo-name">VetCost Pro</span>
            </div>
            <div className="logo-tag">Clinic pricing & P&L platform</div>
          </div>
          <div className="clinic-pill">
            <div className="clinic-name">Tasman Vets</div>
            <div className="clinic-meta">Nelson, NZ · FY2025–26</div>
          </div>
          <nav>
            {navItems.map(item => (
              <div key={item.id}>
                {item.section && <div className="nav-section">{item.section}</div>}
                <div className={`nav-item${page === item.id ? " active" : ""}`} onClick={() => setPage(item.id)}>
                  <Icon d={item.icon} />
                  {item.label}
                  {item.badge && <span className="nav-badge">{item.badge}</span>}
                </div>
              </div>
            ))}
          </nav>
        </div>
        <div className="main">
          <PageComponent state={fullState} update={update} setPage={setPage} />
        </div>
      </div>
    </>
  );
}
