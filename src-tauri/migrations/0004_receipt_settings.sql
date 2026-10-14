-- What the printed receipt says about the pharmacy, and the paper it is printed on ('80', '58' mm rolls or 'a4').
INSERT OR IGNORE INTO settings(key, value) VALUES
  ('receipt_name', 'نظام الصيدلية'),
  ('receipt_address', ''),
  ('receipt_phone', ''),
  ('receipt_footer', 'شكراً لزيارتكم · الأدوية لا تُرد بعد فتح العبوة'),
  ('receipt_paper', '80');
