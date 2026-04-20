$token = (gcloud auth print-access-token)
$url = "https://us-central1-aiplatform.googleapis.com/v1/projects/myaura-production-492012/locations/us-central1/publishers/google/models/imagen-3.0-generate-001:predict"
$body = @{
    instances = @(
        @{
            prompt = "A beautiful landscape"
        }
    )
} | ConvertTo-Json -Depth 10

Write-Host "URL: $url"
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}

try {
    $res = Invoke-RestMethod -Uri $url -Headers $headers -Method Post -Body $body
    Write-Host "SUCCESS!"
    $res | ConvertTo-Json -Depth 10
} catch {
    Write-Host "FAILED!"
    Write-Host "Status: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $bodyRes = $reader.ReadToEnd()
        Write-Host "Body: $bodyRes"
    }
}
