// test/xlsx-format.js — định dạng số / ngày của trình xem Excel (public/js/xlsxView.js): kết quả phải giống Excel
const assert = require('assert');
const { formatNumber: f } = require('../public/js/xlsxView.js');
const cases = [
    [1234.5, '#,##0.00', '1,234.50'], [0.256, '0.0%', '25.6%'], [45000, 'dd/mm/yyyy', '15/03/2023'], [-5, '0;(0)', '(5)'],
    [1234567, '0.00E+00', '1.23E+06'], [1.005, '0.00', '1.01'], [0.5, '# ?/?', '1/2'], [3.14159, 'General', '3.14159'],
    [45000.5, 'h:mm AM/PM', '12:00 PM'], [1234567.891, '#,##0.00;[Red]-#,##0.00', '1,234,567.89'], [-1500, '#,##0.00;[Red]-#,##0.00', '-1,500.00'],
    [1234.5, '"$"#,##0', '$1,235'], [1e12, 'General', '1E+12'], [45000.75, 'dd/mm/yyyy hh:mm', '15/03/2023 18:00'], [45000, 'mmm yyyy', 'Mar 2023'],
    [0, '0.00', '0.00'], [12, '000', '012'], [1234567, '#,##0,', '1,235']
];
let bad = 0;
cases.forEach(([v, c, want]) => { const got = f(v, c, false); if (got.replace(/ /g, ' ') !== want) { bad++; console.log('SAI', v, c, '→', got, '(muốn', want + ')'); } });
assert.strictEqual(bad, 0);
console.log('xlsx-format: ' + cases.length + ' ca đạt');
