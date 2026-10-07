const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { httpError } = require("./xlsxKit");

// Turns a filled-in form workbook into a PDF of its first sheet's print area,
// by driving Microsoft Excel through PowerShell — Excel is what the forms are
// laid out in, so it is the one renderer that prints them exactly as they look.
// Needs Excel installed on the machine running the backend; without it the
// export answers 501 and the Excel download still works.
//
// One conversion at a time: Excel automation does not like being opened twice
// at once, and these are small, occasional exports.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
try {
  $wb = $xl.Workbooks.Open($env:RAP_PDF_IN, 0, $true)
  try { $wb.Worksheets.Item(1).ExportAsFixedFormat(0, $env:RAP_PDF_OUT) } finally { $wb.Close($false) }
} finally {
  $xl.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
}`;
const TIMEOUT_MS = 90000;

let queue = Promise.resolve();

function runExcel(input, output) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, RAP_PDF_IN: input, RAP_PDF_OUT: output }
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve()));
  });
}

async function convert(xlsx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rap-pdf-"));
  const input = path.join(dir, "form.xlsx");
  const output = path.join(dir, "form.pdf");
  try {
    fs.writeFileSync(input, xlsx);
    if (process.platform !== "win32") throw new Error("Excel automation needs Windows");
    await runExcel(input, output);
    return fs.readFileSync(output);
  } catch (err) {
    console.error("[pdf] conversion failed:", err.message);
    throw httpError(501, "PDF export isn't available on this server (it needs Microsoft Excel) — export as Excel instead");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function xlsxToPdf(xlsx) {
  const job = queue.then(() => convert(xlsx));
  queue = job.catch(() => {});
  return job;
}

module.exports = { xlsxToPdf };
