$token = (gcloud auth print-access-token)
$url = "https://us-central1-aiplatform.googleapis.com/v1/projects/myaura-production-492012/locations/us-central1/publishers"
$headers = @{ "Authorization" = "Bearer $token" }
try {
    $res = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
    $res.publishers | ForEach-Object { $_.name }
} catch {
    Write-Host "Failed: $($_.Exception.Message)"
}
