-- Demo data for trying the app. Loaded once, only when the products table is empty.
-- Barcodes use the 20–29 GS1 prefix range (reserved for internal use) so they never clash with real products.
-- Prices are illustrative, in Iraqi dinars.

INSERT INTO branches(id, code, name) VALUES ('br-main', 'MB', 'الفرع الرئيسي');
INSERT INTO users(id, username, full_name, role) VALUES ('u-admin', 'admin', 'مدير النظام', 'admin');

INSERT INTO categories(id, name_ar, name_en) VALUES
  ('cat-rx', 'أدوية بوصفة', 'Prescription'),
  ('cat-otc', 'أدوية بدون وصفة', 'OTC');

INSERT INTO manufacturers(id, name) VALUES
  ('m-merck', 'Merck'), ('m-gsk', 'GSK'), ('m-az', 'AstraZeneca'),
  ('m-local', 'مصنّع محلي'), ('m-spimaco', 'SPIMACO'), ('m-abbott', 'Abbott');

INSERT INTO active_ingredients(id, name_inn, name_ar, drug_class) VALUES
  ('i-metformin', 'Metformin', 'ميتفورمين', 'biguanide'),
  ('i-paracetamol', 'Paracetamol', 'باراسيتامول', 'analgesic'),
  ('i-caffeine', 'Caffeine', 'كافيين', 'stimulant'),
  ('i-amoxicillin', 'Amoxicillin', 'أموكسيسيلين', 'penicillin'),
  ('i-clavulanate', 'Clavulanic acid', 'حمض الكلافولانيك', 'beta-lactamase inhibitor'),
  ('i-bisoprolol', 'Bisoprolol', 'بيسوبرولول', 'beta blocker'),
  ('i-esomeprazole', 'Esomeprazole', 'إيسوميبرازول', 'proton pump inhibitor'),
  ('i-salbutamol', 'Salbutamol', 'سالبيوتامول', 'beta agonist'),
  ('i-ibuprofen', 'Ibuprofen', 'إيبوبروفين', 'nsaid');

INSERT INTO products(id, trade_name, category_id, manufacturer_id, dosage_form, strength_label, pack_size, requires_rx, sell_price, composition_key) VALUES
  ('p-glucophage-850', 'Glucophage 850 mg', 'cat-rx', 'm-merck', 'قرص', '850 mg', 30, 1, 6250, 'metformin:850mg'),
  ('p-metformin-850', 'Metformin 850 (محلي)', 'cat-rx', 'm-local', 'قرص', '850 mg', 30, 1, 4000, 'metformin:850mg'),
  ('p-glucophage-xr', 'Glucophage XR 750 mg', 'cat-rx', 'm-merck', 'قرص ممتد المفعول', '750 mg', 30, 1, 7500, 'metformin:750mg:xr'),
  ('p-panadol-extra', 'Panadol Extra', 'cat-otc', 'm-gsk', 'قرص', '500 mg + 65 mg', 24, 0, 3000, 'caffeine:65mg|paracetamol:500mg'),
  ('p-panadol-500', 'Panadol 500 mg', 'cat-otc', 'm-gsk', 'قرص', '500 mg', 24, 0, 2000, 'paracetamol:500mg'),
  ('p-fevadol-500', 'Fevadol 500 mg', 'cat-otc', 'm-spimaco', 'قرص', '500 mg', 20, 0, 1750, 'paracetamol:500mg'),
  ('p-augmentin-1g', 'Augmentin 1 g', 'cat-rx', 'm-gsk', 'قرص', '875 mg + 125 mg', 14, 1, 18500, 'amoxicillin:875mg|clavulanic acid:125mg'),
  ('p-amoxil-500', 'Amoxil 500 mg', 'cat-rx', 'm-gsk', 'كبسول', '500 mg', 20, 1, 4500, 'amoxicillin:500mg'),
  ('p-concor-5', 'Concor 5 mg', 'cat-rx', 'm-merck', 'قرص', '5 mg', 30, 1, 9000, 'bisoprolol:5mg'),
  ('p-nexium-40', 'Nexium 40 mg', 'cat-rx', 'm-az', 'قرص', '40 mg', 14, 1, 15000, 'esomeprazole:40mg'),
  ('p-ventolin', 'Ventolin Inhaler', 'cat-rx', 'm-gsk', 'بخاخ', '100 mcg/dose', 1, 1, 7000, 'salbutamol:100mcg'),
  ('p-brufen-400', 'Brufen 400 mg', 'cat-otc', 'm-abbott', 'قرص', '400 mg', 30, 0, 3500, 'ibuprofen:400mg');

INSERT INTO product_ingredients(product_id, ingredient_id, strength_value, strength_unit) VALUES
  ('p-glucophage-850', 'i-metformin', 850, 'mg'),
  ('p-metformin-850', 'i-metformin', 850, 'mg'),
  ('p-glucophage-xr', 'i-metformin', 750, 'mg'),
  ('p-panadol-extra', 'i-paracetamol', 500, 'mg'),
  ('p-panadol-extra', 'i-caffeine', 65, 'mg'),
  ('p-panadol-500', 'i-paracetamol', 500, 'mg'),
  ('p-fevadol-500', 'i-paracetamol', 500, 'mg'),
  ('p-augmentin-1g', 'i-amoxicillin', 875, 'mg'),
  ('p-augmentin-1g', 'i-clavulanate', 125, 'mg'),
  ('p-amoxil-500', 'i-amoxicillin', 500, 'mg'),
  ('p-concor-5', 'i-bisoprolol', 5, 'mg'),
  ('p-nexium-40', 'i-esomeprazole', 40, 'mg'),
  ('p-ventolin', 'i-salbutamol', 100, 'mcg'),
  ('p-brufen-400', 'i-ibuprofen', 400, 'mg');

INSERT INTO product_barcodes(code, product_id) VALUES
  ('2000000000015', 'p-glucophage-850'),
  ('2000000000022', 'p-metformin-850'),
  ('2000000000039', 'p-glucophage-xr'),
  ('2000000000046', 'p-panadol-extra'),
  ('2000000000053', 'p-panadol-500'),
  ('2000000000060', 'p-fevadol-500'),
  ('2000000000077', 'p-augmentin-1g'),
  ('2000000000084', 'p-amoxil-500'),
  ('2000000000091', 'p-concor-5'),
  ('2000000000107', 'p-nexium-40'),
  ('2000000000114', 'p-ventolin'),
  ('2000000000121', 'p-brufen-400');

INSERT INTO suppliers(id, name, payment_terms_days) VALUES
  ('s-a', 'المورد أ (تجريبي)', 30),
  ('s-b', 'المورد ب (تجريبي)', 45);

-- Batches with expiries relative to the install date, so the demo always shows near-expiry and expired stock.
INSERT INTO batches(id, product_id, branch_id, batch_no, expiry_date, unit_cost, sell_price, qty_on_hand, supplier_id) VALUES
  ('b-gl-554',  'p-glucophage-850', 'br-main', 'GL554',  date('now', '+300 days'), 5000, 6250, 46, 's-a'),
  ('b-gl-601',  'p-glucophage-850', 'br-main', 'GL601',  date('now', '+520 days'), 5050, 6250, 30, 's-a'),
  ('b-mf-220',  'p-metformin-850',  'br-main', 'MF220',  date('now', '+400 days'), 2900, 4000, 120, 's-b'),
  ('b-px-0921', 'p-panadol-extra',  'br-main', 'PX0921', date('now', '+48 days'),  2050, 3000, 24, 's-a'),
  ('b-px-1104', 'p-panadol-extra',  'br-main', 'PX1104', date('now', '+260 days'), 2100, 3000, 60, 's-a'),
  ('b-px-1210', 'p-panadol-extra',  'br-main', 'PX1210', date('now', '+440 days'), 2150, 3000, 96, 's-b'),
  ('b-pn-300',  'p-panadol-500',    'br-main', 'PN300',  date('now', '+600 days'), 1400, 2000, 80, 's-a'),
  ('b-fv-77',   'p-fevadol-500',    'br-main', 'FV77',   date('now', '+150 days'), 1200, 1750, 40, 's-b'),
  ('b-au-2311', 'p-augmentin-1g',   'br-main', 'B2311',  date('now', '+170 days'), 14800, 18500, 18, 's-a'),
  ('b-am-009',  'p-amoxil-500',     'br-main', 'AM009',  date('now', '-5 days'),   2900, 4500, 4, 's-a'),
  ('b-am-014',  'p-amoxil-500',     'br-main', 'AM014',  date('now', '+22 days'),  2900, 4500, 18, 's-a'),
  ('b-cn-118',  'p-concor-5',       'br-main', 'CN118',  date('now', '+470 days'), 7200, 9000, 25, 's-b'),
  ('b-nx-40a',  'p-nexium-40',      'br-main', 'NX40A',  date('now', '+135 days'), 11800, 15000, 42, 's-b'),
  ('b-vt-501',  'p-ventolin',       'br-main', 'VT501',  date('now', '+75 days'),  5400, 7000, 9, 's-a'),
  ('b-br-400',  'p-brufen-400',     'br-main', 'BR400',  date('now', '+380 days'), 2400, 3500, 55, 's-b');

INSERT INTO stock_movements(id, batch_id, type, qty, unit_cost, ref_type, user_id)
  SELECT 'mv-open-' || id, id, 'opening', qty_on_hand, unit_cost, 'demo_seed', 'u-admin' FROM batches;

INSERT INTO reorder_rules(product_id, branch_id, min_qty, reorder_level, max_qty, preferred_supplier_id) VALUES
  ('p-panadol-extra', 'br-main', 40, 60, 200, 's-a'),
  ('p-amoxil-500', 'br-main', 15, 25, 80, 's-a'),
  ('p-ventolin', 'br-main', 8, 15, 50, 's-a');

INSERT INTO patients(id, full_name, phone, credit_limit) VALUES
  ('pt-demo-1', 'أحمد كريم (تجريبي)', '07700000001', 100000);
INSERT INTO patient_allergies(patient_id, ingredient_id, drug_class) VALUES
  ('pt-demo-1', NULL, 'penicillin');

INSERT INTO settings(key, value) VALUES ('demo_data', '1');
