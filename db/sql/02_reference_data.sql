-- =====================================================================
-- 02_reference_data.sql  —  the constants that used to be hard-coded in
-- src/App.js (ROOM_RATES, BED_CAPACITY, DOCTORS, SPECIALTY_KEYWORDS,
-- DISEASE_PROFILES, emergency labels/notes, name pools).
-- =====================================================================

INSERT INTO hms.room_type (code, display_order, hourly_rate, stay_factor) VALUES
    ('General', 1,  285, 0.95),
    ('Normal',  2,  350, 1.00),
    ('Deluxe',  3,  450, 1.08),
    ('ICU',     4, 1400, 1.28);

-- 300 beds numbered in blocks exactly like the old BedHeap.getBedType():
-- 1-120 General, 121-210 Normal, 211-270 Deluxe, 271-300 ICU
INSERT INTO hms.bed (bed_no, room_type)
SELECT n, CASE WHEN n <= 120 THEN 'General'
               WHEN n <= 210 THEN 'Normal'
               WHEN n <= 270 THEN 'Deluxe'
               ELSE 'ICU' END
FROM generate_series(1, 300) AS n;

INSERT INTO hms.emergency_level (level, label, protocol_note, base_wait_seconds) VALUES
    (1, 'Stable',   'Standard emergency protocol.',                      480),
    (2, 'Minor',    'Standard emergency protocol.',                      360),
    (3, 'Moderate', 'Standard emergency protocol.',                      240),
    (4, 'Severe',   'Fast-track diagnostics advised.',                   120),
    (5, 'Critical', 'High priority monitoring and rapid intervention.',   60),
    (6, 'Urgent',   'Priority trauma/critical response required.',        30),
    (7, 'Code Red', 'Immediate resuscitation team activated.',            15);

INSERT INTO hms.specialty (name, match_order) VALUES
    ('Cardiology',          1),
    ('Pulmonology',         2),
    ('Neurology',           3),
    ('Orthopedics',         4),
    ('Nephrology',          5),
    ('Gastroenterology',    6),
    ('Dermatology',         7),
    ('Infectious Disease',  8),
    ('Trauma Surgery',      9),
    ('Critical Care',      10),
    ('General Medicine',  NULL),   -- the fallback when nothing matches
    ('Emergency Medicine', NULL);

INSERT INTO hms.specialty_keyword (specialty, keyword)
SELECT s, k FROM (VALUES
    ('Cardiology',         ARRAY['heart','cardiac','chest pain','blood pressure','stroke','rhythm']),
    ('Pulmonology',        ARRAY['asthma','pneumonia','bronch','lung','covid','respiratory','chest congestion']),
    ('Neurology',          ARRAY['migraine','seizure','vertigo','panic','head injury']),
    ('Orthopedics',        ARRAY['fracture','injury','burn','trauma']),
    ('Nephrology',         ARRAY['kidney','urinary']),
    ('Gastroenterology',   ARRAY['liver','stomach','append','ulcer','gall bladder','gastro','food poisoning']),
    ('Dermatology',        ARRAY['skin','allergy','rash']),
    ('Infectious Disease', ARRAY['sepsis','dengue','malaria','typhoid','chikungunya','viral']),
    ('Trauma Surgery',     ARRAY['accident','trauma','fracture','head injury','burn']),
    ('Critical Care',      ARRAY['failure','critical','stroke','shock'])
) AS v(s, kw), unnest(kw) AS k;

-- maxPatients already doubled, as App.js did with DOCTORS.forEach(d => d.maxPatients *= 2)
INSERT INTO hms.doctor (doctor_id, full_name, specialty, max_patients) VALUES
    (1, 'Dr. House',         'Cardiology',         40),
    (2, 'Dr. Alan Reed',     'Pulmonology',        48),
    (3, 'Dr. Arjun Mehta',   'Neurology',          40),
    (4, 'Dr. Kavya Iyer',    'Orthopedics',        52),
    (5, 'Dr. Nikhil Batra',  'General Medicine',   60),
    (6, 'Dr. Rahul Verma',   'Emergency Medicine', 48),
    (7, 'Dr. Vikram Sethi',  'Infectious Disease', 44),
    (8, 'Dr. Martin Dsouza', 'Critical Care',      36);

INSERT INTO hms.disease_profile
    (profile_id, label, match_order, is_default, min_stay_hours, max_stay_hours, treatment_cost, diagnostics_cost, procedure_cost)
VALUES
    (1, 'Critical', 1,    false, 96, 360, 24000, 6500, 18000),
    (2, 'Acute',    2,    false, 48, 168, 14500, 4200,  9500),
    (3, 'Moderate', 3,    false, 24, 120,  9200, 3000,  4200),
    (4, 'Mild',     4,    false,  6,  48,  3800, 1200,     0),
    (5, 'Default',  NULL, true,   8,  36,  2200,    0,     0);

INSERT INTO hms.disease_profile_keyword (profile_id, keyword)
SELECT p, k FROM (VALUES
    (1, ARRAY['heart failure','stroke','sepsis','burn','road accident','trauma','kidney failure']),
    (2, ARRAY['pneumonia','appendicitis','covid','dengue','malaria','chest pain']),
    (3, ARRAY['fracture','infection','kidney stone','liver','thyroid','asthma','typhoid']),
    (4, ARRAY['migraine','viral fever','food poisoning','allergy','flu','vertigo','dehydration','panic','sinus'])
) AS v(p, kw), unnest(kw) AS k;

INSERT INTO hms.sim_name_pool (kind, name)
SELECT 'FIRST', unnest(ARRAY['Oliver','William','James','Benjamin','Lucas','Henry','Mason','Michael','Ethan','Daniel',
    'Jacob','Logan','Jackson','Levi','Sebastian','Mateo','Owen','Emma','Olivia','Ava','Isabella','Sophia','Charlotte',
    'Mia','Amelia','Harper','Abigail','Emily','Elizabeth','Mila','Ella','Sofia','Camila','Aria','Rahul','Aarav','Neha',
    'Diya','Rohan'])
UNION ALL
SELECT 'LAST', unnest(ARRAY['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
    'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez',
    'Thompson','White','Harris','Sanchez','Clark','Ramirez','Patel','Sharma','Singh','Kumar']);

INSERT INTO hms.app_setting (key, value) VALUES
    ('demo_imported',          'false'),
    ('live_time_acceleration', '1200'),   -- 1 real second = 20 simulated minutes (LIVE_TIME_ACCELERATION)
    ('live_queue_cap',         '300'),    -- live mode stops adding arrivals above this queue length
    ('session_ttl_hours',      '12');
