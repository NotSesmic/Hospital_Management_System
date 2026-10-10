// The business formulas exactly as they were in the original src/App.js
// (commit 0a972dc), copied verbatim so the tests can prove the database
// packages reproduce them. Do not "fix" anything in here.

const ROOM_RATES = { General: 285, Normal: 350, Deluxe: 450, ICU: 1400 };
const SPECIALTY_KEYWORDS = [
  { specialty: 'Cardiology', words: ['heart', 'cardiac', 'chest pain', 'blood pressure', 'stroke', 'rhythm'] },
  { specialty: 'Pulmonology', words: ['asthma', 'pneumonia', 'bronch', 'lung', 'covid', 'respiratory', 'chest congestion'] },
  { specialty: 'Neurology', words: ['migraine', 'seizure', 'vertigo', 'panic', 'head injury'] },
  { specialty: 'Orthopedics', words: ['fracture', 'injury', 'burn', 'trauma'] },
  { specialty: 'Nephrology', words: ['kidney', 'urinary'] },
  { specialty: 'Gastroenterology', words: ['liver', 'stomach', 'append', 'ulcer', 'gall bladder', 'gastro', 'food poisoning'] },
  { specialty: 'Dermatology', words: ['skin', 'allergy', 'rash'] },
  { specialty: 'Infectious Disease', words: ['sepsis', 'dengue', 'malaria', 'typhoid', 'chikungunya', 'viral'] },
  { specialty: 'Trauma Surgery', words: ['accident', 'trauma', 'fracture', 'head injury', 'burn'] },
  { specialty: 'Critical Care', words: ['failure', 'critical', 'stroke', 'shock'] }
];
const DISEASE_PROFILES = [
  { words: ['heart failure', 'stroke', 'sepsis', 'burn', 'road accident', 'trauma', 'kidney failure'], stayHours: [96, 360], treatmentCost: 24000, diagnostics: 6500, procedure: 18000 },
  { words: ['pneumonia', 'appendicitis', 'covid', 'dengue', 'malaria', 'chest pain'], stayHours: [48, 168], treatmentCost: 14500, diagnostics: 4200, procedure: 9500 },
  { words: ['fracture', 'infection', 'kidney stone', 'liver', 'thyroid', 'asthma', 'typhoid'], stayHours: [24, 120], treatmentCost: 9200, diagnostics: 3000, procedure: 4200 },
  { words: ['migraine', 'viral fever', 'food poisoning', 'allergy', 'flu', 'vertigo', 'dehydration', 'panic', 'sinus'], stayHours: [6, 48], treatmentCost: 3800, diagnostics: 1200, procedure: 0 }
];

const inferSpecialty = (disease) => {
  const text = disease.toLowerCase();
  const found = SPECIALTY_KEYWORDS.find((item) => item.words.some((word) => text.includes(word)));
  return found ? found.specialty : 'General Medicine';
};

const getDiseaseProfile = (disease) => {
  const txt = disease.toLowerCase();
  const matched = DISEASE_PROFILES.find((profile) => profile.words.some((word) => txt.includes(word)));
  return matched || { stayHours: [8, 36], treatmentCost: 2200 };
};

const estimateStayHours = (patient, roomTypeOverride) => {
  const profile = getDiseaseProfile(patient.disease);
  const [minStay, maxStay] = profile.stayHours;
  const spread = Math.max(1, maxStay - minStay);
  const baseStay = minStay + ((patient.id * 11 + patient.emergencyLevel * 7) % spread);
  const roomType = roomTypeOverride || patient.roomType || patient.preferredRoom || 'Normal';
  const roomFactor = { General: 0.95, Normal: 1, Deluxe: 1.08, ICU: 1.28 }[roomType] || 1;
  const emergencyFactor = 1 + (Math.max(1, Math.min(7, patient.emergencyLevel || 3)) - 3) * 0.11;
  const diseaseFactor = profile.treatmentCost >= 20000 ? 1.22 : profile.treatmentCost >= 12000 ? 1.1 : 1;
  const adjusted = Math.round(baseStay * roomFactor * emergencyFactor * diseaseFactor);
  return Math.max(2, adjusted);
};

const safeMoney = (num) => {
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.round(num));
};

const createFeedback = (patient) => {
  const complaintTypes = ['Cleanliness', 'Waiting Time', 'Staff Responsiveness', 'Billing Desk', 'Food Quality', 'No Major Complaint'];
  const complaintBodies = [
    'Admission process was smooth but initial room transfer took longer than expected.',
    'Nursing team was attentive; however, medicine delivery missed one scheduled window.',
    'Housekeeping standards were good, though washroom sanitization can be more frequent.',
    'Doctor communication was clear, but attendants wanted more frequent status updates.',
    'Discharge billing queue was busy during peak hours and felt slightly delayed.',
    'Overall experience remained stable with no significant concerns.'
  ];
  const suggestions = [
    'Add one more billing counter during evening discharge rush.',
    'Introduce digital nursing call tracking for quicker non-emergency responses.',
    'Increase attendant communication rounds to every 4 hours.',
    'Expand housekeeping checks for shared facilities at fixed intervals.',
    'Provide bedside discharge summary preview before final bill generation.',
    'Maintain current quality standards and continue periodic audits.'
  ];
  const rating = 3 + (patient.id % 3);
  const idx = (patient.id + patient.emergencyLevel) % complaintTypes.length;
  return {
    rating,
    complaintType: complaintTypes[idx],
    complaintText: complaintBodies[(idx + patient.id) % complaintBodies.length],
    suggestion: suggestions[(idx + patient.emergencyLevel) % suggestions.length]
  };
};

const buildBill = (patient, dischargeTime) => {
  const rawStay = Number((dischargeTime - patient.bedAllocTime) / (1000 * 60 * 60));
  const stayHours = patient.estimatedStayHours || Math.max(1, Math.ceil(Number.isFinite(rawStay) ? rawStay : 1));

  const diseaseText = (patient.disease || '').toLowerCase();
  const isSevere = patient.emergencyLevel >= 5 || diseaseText.includes('accident') || diseaseText.includes('severe') || diseaseText.includes('trauma') || diseaseText.includes('burn') || diseaseText.includes('stroke') || diseaseText.includes('failure');
  const billedHours = isSevere ? Math.ceil(stayHours / 24) * 24 : stayHours;

  const roomRate = ROOM_RATES[patient.roomType] || ROOM_RATES.General;
  const roomCharge = safeMoney(billedHours * roomRate);
  const profile = getDiseaseProfile(patient.disease);
  const emergencyCharge = safeMoney(patient.emergencyLevel * 950);
  const doctorFee = safeMoney(1400 + patient.emergencyLevel * 700);
  const nursingCharge = safeMoney(Math.ceil(stayHours / 24) * 950);
  const pharmacyCharge = safeMoney(profile.treatmentCost * 0.35);
  const diagnosticsCharge = safeMoney(profile.diagnostics + patient.emergencyLevel * 350);
  const procedureCharge = safeMoney(profile.procedure);
  const treatmentCharge = safeMoney(profile.treatmentCost);
  const serviceCharge = 1400;
  const subtotal = safeMoney(roomCharge + emergencyCharge + doctorFee + nursingCharge + pharmacyCharge + diagnosticsCharge + procedureCharge + treatmentCharge + serviceCharge);
  const gst = safeMoney(subtotal * 0.05);
  const insuranceDiscount = patient.id % 4 === 0 ? safeMoney(subtotal * 0.12) : 0;
  const total = safeMoney(subtotal + gst - insuranceDiscount);
  return { stayHours, roomRate, roomCharge, emergencyCharge, doctorFee, nursingCharge, pharmacyCharge, diagnosticsCharge, procedureCharge, treatmentCharge, serviceCharge, subtotal, gst, insuranceDiscount, total };
};

module.exports = { inferSpecialty, getDiseaseProfile, estimateStayHours, createFeedback, buildBill, ROOM_RATES };
