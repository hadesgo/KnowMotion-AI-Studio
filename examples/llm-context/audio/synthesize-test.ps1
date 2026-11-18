param([string]$TextPath,[string]$OutputPath)
Add-Type -AssemblyName System.Speech
$text = Get-Content -Raw -LiteralPath $TextPath
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SelectVoice('Microsoft Huihui Desktop')
  $synth.Rate = -1
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($OutputPath, $format)
  $synth.Speak($text)
} finally { $synth.Dispose() }
