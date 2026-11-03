# Generates the PWA icons (navy square, mint rounded-square outline, centred glyph).
# Usage: powershell -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function New-Icon([string]$glyph, [int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0b1220'))
  $mint = [System.Drawing.ColorTranslator]::FromHtml('#5eead4')

  # Rounded-square outline
  $margin = $size * 0.16
  $side = $size - 2 * $margin
  $radius = $side * 0.22
  $d = $radius * 2
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddArc($margin, $margin, $d, $d, 180, 90)
  $gp.AddArc($margin + $side - $d, $margin, $d, $d, 270, 90)
  $gp.AddArc($margin + $side - $d, $margin + $side - $d, $d, $d, 0, 90)
  $gp.AddArc($margin, $margin + $side - $d, $d, $d, 90, 90)
  $gp.CloseFigure()
  $pen = New-Object System.Drawing.Pen($mint, [single]($size * 0.045))
  $pen.LineJoin = 'Round'
  $g.DrawPath($pen, $gp)

  # Centred glyph
  $font = New-Object System.Drawing.Font('Segoe UI', [single]($size * 0.36), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $brush = New-Object System.Drawing.SolidBrush($mint)
  $rect = New-Object System.Drawing.RectangleF(0, [single]($size * 0.02), $size, $size)
  $g.DrawString($glyph, $font, $brush, $rect, $sf)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $pen.Dispose(); $brush.Dispose(); $font.Dispose(); $gp.Dispose()
}

foreach ($app in @(@{ dir = 'live'; glyph = 'L' }, @{ dir = 'recorded'; glyph = 'S' })) {
  $outDir = Join-Path $root "$($app.dir)\icons"
  New-Item -ItemType Directory -Force $outDir | Out-Null
  foreach ($size in 180, 192, 512) {
    $p = Join-Path $outDir "icon-$size.png"
    New-Icon $app.glyph $size $p
    Write-Host "wrote $p"
  }
}
