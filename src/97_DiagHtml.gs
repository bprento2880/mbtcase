/** Probe nama file HTML yang benar-benar terlihat oleh runtime GAS. */
function diagHtmlFiles() {
  var cand = [
    'ui/Index', 'ui/css', 'ui/js_core', 'ui/js_pages',
    'ui/partials_appbar', 'ui/partials_case_list', 'ui/partials_case_detail',
    // varian salah nama yang sering terjadi:
    'ui/Partials case detail', 'ui/partials case detail',
    'ui/Partials_case_detail', 'partials_case_detail'
  ];
  cand.forEach(function (n) {
    var ok = true;
    try { HtmlService.createHtmlOutputFromFile(n); } catch (e) { ok = false; }
    console.log((ok ? 'OK   ' : 'MISS ') + n);
  });
}