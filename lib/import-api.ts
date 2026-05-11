/**
 * Sales Import API Client with comprehensive logging
 * Logs to browser console at every step to track crashes
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_IMPORT_API_URL || 'https://test1-production-50f5.up.railway.app';

interface ImportResult {
  file: string;
  line_count: number;
  items_inserted: number;
  document_id?: string;
  totals_match?: boolean;
  totals_diff?: Record<string, any>;
  footer_totals?: Record<string, number>;
  footer_align?: Record<string, any>;
  error?: string;
}

/**
 * Import Excel/CSV/PDF file to the sales API
 * Extensive console logging at each step
 */
export async function importSalesFile(
  file: File,
  options: { dryRun?: boolean; sheet?: string } = {}
): Promise<ImportResult> {
  const { dryRun = false, sheet } = options;
  
  // === STEP 1: Initial File Info ===
  console.group('🔍 [IMPORT] Starting Sales File Import');
  console.log('[IMPORT] Timestamp:', new Date().toISOString());
  console.log('[IMPORT] File Details:', {
    name: file.name,
    size: `${(file.size / 1024).toFixed(2)} KB`,
    type: file.type || 'unknown',
    lastModified: new Date(file.lastModified).toISOString(),
  });
  
  // === STEP 2: Build FormData ===
  console.log('[IMPORT] Building FormData...');
  const formData = new FormData();
  formData.append('file', file);
  
  // Debug FormData contents
  const formDataEntries: Record<string, any> = {};
  formData.forEach((value, key) => {
    formDataEntries[key] = value instanceof File 
      ? `File: ${value.name} (${value.size} bytes)`
      : value;
  });
  console.log('[IMPORT] FormData entries:', formDataEntries);
  
  // === STEP 3: Build URL ===
  const url = new URL('/import', API_BASE_URL);
  if (dryRun) url.searchParams.append('dry_run', 'true');
  if (sheet) url.searchParams.append('sheet', sheet);
  
  console.log('[IMPORT] API URL:', url.toString());
  console.log('[IMPORT] Request Method: POST');
  console.log('[IMPORT] Headers: { /* FormData sets Content-Type automatically */ }');
  console.groupEnd();
  
  // === STEP 4: Send Request ===
  console.group('📤 [IMPORT] Sending Request');
  const startTime = performance.now();
  let response: Response;
  
  try {
    console.log('[IMPORT] Calling fetch()...');
    response = await fetch(url.toString(), {
      method: 'POST',
      body: formData,
      // NO Content-Type header - browser sets it with multipart boundary
    });
    
    const duration = (performance.now() - startTime).toFixed(0);
    console.log('[IMPORT] Response received:', {
      status: response.status,
      statusText: response.statusText,
      duration: `${duration}ms`,
      ok: response.ok,
    });
    
    // Log response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    console.log('[IMPORT] Response Headers:', responseHeaders);
    
  } catch (networkError) {
    console.groupEnd();
    console.group('❌ [IMPORT] Network Error');
    console.error('[IMPORT] Fetch failed:', networkError);
    
    // Diagnose common network errors
    if (networkError instanceof TypeError) {
      if (networkError.message.includes('fetch')) {
        console.error('[IMPORT] 🔴 CORS or Network Error - Check:');
        console.error('  1. API URL is correct:', API_BASE_URL);
        console.error('  2. API server is running');
        console.error('  3. CORS is enabled on API (we added this)');
        console.error('  4. No ad-blocker blocking the request');
      }
      if (networkError.message.includes('abort')) {
        console.error('[IMPORT] 🔴 Request was aborted (timeout?)');
      }
    }
    
    console.groupEnd();
    throw new Error(`Network error: ${networkError instanceof Error ? networkError.message : 'Unknown'}`);
  }
  
  console.groupEnd();
  
  // === STEP 5: Parse Response ===
  console.group('📥 [IMPORT] Processing Response');
  
  let responseBody: string;
  try {
    console.log('[IMPORT] Reading response body...');
    responseBody = await response.text();
    console.log('[IMPORT] Raw response length:', responseBody.length, 'chars');
    
    if (responseBody.length < 1000) {
      console.log('[IMPORT] Raw response body:', responseBody);
    } else {
      console.log('[IMPORT] Raw response (first 500 chars):', responseBody.substring(0, 500) + '...');
    }
  } catch (readError) {
    console.error('[IMPORT] Failed to read response body:', readError);
    console.groupEnd();
    throw new Error('Failed to read API response');
  }
  
  // === STEP 6: Handle HTTP Errors ===
  if (!response.ok) {
    console.group('❌ [IMPORT] HTTP Error Response');
    console.error('[IMPORT] Status:', response.status, response.statusText);
    console.error('[IMPORT] Error body:', responseBody);
    
    // Try to parse error as JSON
    let errorDetail = responseBody;
    try {
      const errorJson = JSON.parse(responseBody);
      errorDetail = errorJson.detail || errorJson.message || JSON.stringify(errorJson);
      console.error('[IMPORT] Parsed error:', errorJson);
    } catch {
      // Not JSON, use raw body
    }
    
    console.groupEnd();
    console.groupEnd();
    
    throw new Error(`Import failed (${response.status}): ${errorDetail}`);
  }
  
  // === STEP 7: Parse Success Response ===
  console.log('[IMPORT] Parsing JSON response...');
  let result: ImportResult;
  
  try {
    result = JSON.parse(responseBody);
    console.log('[IMPORT] Parsed result:', result);
  } catch (parseError) {
    console.error('[IMPORT] JSON parse error:', parseError);
    console.error('[IMPORT] Invalid JSON received:', responseBody.substring(0, 200));
    console.groupEnd();
    console.groupEnd();
    throw new Error('Invalid JSON response from API');
  }
  
  // === STEP 8: Log Success Summary ===
  console.group('✅ [IMPORT] Success Summary');
  console.log('[IMPORT] Document ID:', result.document_id || 'N/A (dry_run?)');
  console.log('[IMPORT] Lines Parsed:', result.line_count);
  console.log('[IMPORT] Items Inserted:', result.items_inserted);
  console.log('[IMPORT] Totals Match:', result.totals_match);
  
  if (result.footer_totals) {
    console.log('[IMPORT] Footer Totals:', result.footer_totals);
  }
  if (result.footer_align) {
    console.log('[IMPORT] Footer Alignment:', result.footer_align);
  }
  if (result.totals_diff && Object.keys(result.totals_diff).length > 0) {
    console.warn('[IMPORT] Totals Discrepancy:', result.totals_diff);
  }
  
  console.groupEnd();
  console.groupEnd();
  
  return result;
}

/**
 * Quick health check for the API
 */
export async function checkApiHealth(): Promise<boolean> {
  console.log('[IMPORT] Checking API health...');
  
  try {
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: 'GET',
    });
    
    const ok = response.ok;
    console.log('[IMPORT] Health check:', ok ? '✅ OK' : '❌ Failed', response.status);
    
    if (ok) {
      const data = await response.json();
      console.log('[IMPORT] Health response:', data);
    }
    
    return ok;
  } catch (error) {
    console.error('[IMPORT] Health check failed:', error);
    return false;
  }
}

// Export config for debugging
export const IMPORT_CONFIG = {
  API_BASE_URL,
  version: '1.0.0',
};

console.log('[IMPORT] Module loaded. Config:', IMPORT_CONFIG);
