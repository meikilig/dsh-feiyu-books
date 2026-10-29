# Windows built-in OCR (Windows.Media.Ocr) over a folder of page images.
# Uses the installed zh-CN OCR language pack; no network, no extra installs.
#
# Usage: powershell -File ocr.ps1 -Dir <image dir> -Out <output.txt> [-MaxPages N] [-Filter *.jpg]
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxPages = 0,
  [string]$Filter = '*.jpg'
)

$ErrorActionPreference = 'Stop'

[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$engine = $null
try {
  $lang = New-Object Windows.Globalization.Language 'zh-CN'
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
} catch { }
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { Write-Error 'no OCR engine available for zh-CN'; exit 2 }
Write-Host ("OCR language: " + $engine.RecognizerLanguage.LanguageTag)

$files = Get-ChildItem -LiteralPath $Dir -Filter $Filter -File | Sort-Object Name
if ($MaxPages -gt 0) { $files = @($files | Select-Object -First $MaxPages) }
Write-Host ("pages to process: " + @($files).Count)

$sb = New-Object System.Text.StringBuilder
$i = 0
foreach ($f in $files) {
  $i++
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($f.FullName)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $text = ($result.Lines | ForEach-Object { $_.Text }) -join "`n"
    [void]$sb.AppendLine("<!-- page " + $f.Name + " -->")
    [void]$sb.AppendLine($text)
    [void]$sb.AppendLine('')
    $bitmap.Dispose()
    $stream.Dispose()
  } catch {
    [void]$sb.AppendLine("<!-- page " + $f.Name + " FAILED: " + $_.Exception.Message + " -->")
    Write-Warning ($f.Name + ' failed: ' + $_.Exception.Message)
  }
  if ($i % 20 -eq 0) { Write-Host ("  processed " + $i + '/' + @($files).Count) }
}

[IO.File]::WriteAllText($Out, $sb.ToString(), (New-Object Text.UTF8Encoding($false)))
Write-Host ("done: " + $Out)
