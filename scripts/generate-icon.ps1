Add-Type -AssemblyName System.Drawing

$iconDirectory = Join-Path $PSScriptRoot "..\src-tauri\icons"
$sourcePath = Join-Path $iconDirectory "orbiterm-icon.png"
$outputPath = Join-Path $iconDirectory "orbiterm-icon-taskbar.png"
$source = [System.Drawing.Bitmap]::FromFile($sourcePath)
$output = New-Object System.Drawing.Bitmap 1024, 1024, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($output)
$graphics.Clear([System.Drawing.Color]::Transparent)
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# Crop the transparent margin so the mark remains legible at Windows taskbar sizes.
$sourceRect = New-Object System.Drawing.Rectangle 160, 150, 930, 930
$targetRect = New-Object System.Drawing.Rectangle 20, 20, 984, 984
$graphics.DrawImage($source, $targetRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
$output.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$output.Dispose()
$source.Dispose()
Write-Output $outputPath
