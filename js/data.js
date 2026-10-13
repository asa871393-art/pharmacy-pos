// بيانات تجريبية — استبدلها ببيانات صيدليتك أو اربطها بقاعدة البيانات لاحقاً
window.CATEGORIES = [
  { id: 'all', label: 'الكل' },
  { id: 'pain', label: 'مسكنات' },
  { id: 'anti', label: 'مضادات حيوية' },
  { id: 'stomach', label: 'الجهاز الهضمي' },
  { id: 'resp', label: 'تنفسي وحساسية' },
  { id: 'chronic', label: 'أمراض مزمنة' },
  { id: 'vit', label: 'فيتامينات' }
];

// rx: يحتاج وصفة طبية | exp: تاريخ انتهاء قريب (فارغ إذا لا يوجد تنبيه)
window.PRODUCTS = [
  { id: 'p1', name: 'بنادول 500', generic: 'باراسيتامول', form: 'أقراص · 24 قرص', cat: 'pain', price: 3000, stock: 48, rx: false, exp: '', barcode: '' },
  { id: 'p2', name: 'أوگمنتين 1غ', generic: 'أموكسيسيلين + كلافيولانيك', form: 'أقراص · 14 قرص', cat: 'anti', price: 9500, stock: 6, rx: true, exp: '', barcode: '' },
  { id: 'p3', name: 'بروفين 400', generic: 'آيبوبروفين', form: 'أقراص · 30 قرص', cat: 'pain', price: 2500, stock: 35, rx: false, exp: '', barcode: '' },
  { id: 'p4', name: 'أوميبرازول 20', generic: 'أوميبرازول', form: 'كبسول · 14 كبسولة', cat: 'stomach', price: 4000, stock: 22, rx: false, exp: '11/2026', barcode: '' },
  { id: 'p5', name: 'فنتولين', generic: 'سالبيوتامول', form: 'بخاخ · 200 جرعة', cat: 'resp', price: 6500, stock: 4, rx: true, exp: '', barcode: '' },
  { id: 'p6', name: 'فيتامين C 1000', generic: 'حمض الأسكوربيك', form: 'أقراص فوارة · 20', cat: 'vit', price: 5000, stock: 60, rx: false, exp: '', barcode: '' },
  { id: 'p7', name: 'سيتريزين 10', generic: 'سيتريزين', form: 'أقراص · 10 أقراص', cat: 'resp', price: 1500, stock: 0, rx: false, exp: '', barcode: '' },
  { id: 'p8', name: 'ميتفورمين 850', generic: 'ميتفورمين', form: 'أقراص · 30 قرص', cat: 'chronic', price: 3500, stock: 18, rx: true, exp: '12/2026', barcode: '' }
];

window.LOW_STOCK = 6; // حد تنبيه المخزون المنخفض
window.CURRENCY = 'د.ع';
