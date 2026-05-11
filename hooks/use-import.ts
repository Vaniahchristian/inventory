/**
 * React hook for sales file imports with state management and logging
 */

import { useState, useCallback } from 'react';
import { importSalesFile, checkApiHealth, IMPORT_CONFIG } from '@/lib/import-api';

interface ImportState {
  isLoading: boolean;
  error: string | null;
  result: {
    lineCount: number;
    itemsInserted: number;
    documentId?: string;
    totalsMatch?: boolean;
  } | null;
}

interface UseImportOptions {
  onSuccess?: (result: ImportState['result']) => void;
  onError?: (error: string) => void;
}

export function useImport(options: UseImportOptions = {}) {
  const [state, setState] = useState<ImportState>({
    isLoading: false,
    error: null,
    result: null,
  });

  console.log('[useImport] Hook initialized. API:', IMPORT_CONFIG.API_BASE_URL);

  const importFile = useCallback(async (
    file: File,
    opts: { dryRun?: boolean; sheet?: string } = {}
  ) => {
    console.group('🚀 [useImport] importFile called');
    console.log('[useImport] File:', file.name, 'Options:', opts);
    
    setState(prev => ({ ...prev, isLoading: true, error: null, result: null }));

    try {
      const apiResult = await importSalesFile(file, opts);
      
      const simplifiedResult = {
        lineCount: apiResult.line_count,
        itemsInserted: apiResult.items_inserted,
        documentId: apiResult.document_id,
        totalsMatch: apiResult.totals_match,
      };
      
      setState({
        isLoading: false,
        error: null,
        result: simplifiedResult,
      });
      
      console.log('[useImport] Success, calling onSuccess callback');
      options.onSuccess?.(simplifiedResult);
      
      console.groupEnd();
      return simplifiedResult;
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[useImport] Import failed:', errorMessage);
      
      setState({
        isLoading: false,
        error: errorMessage,
        result: null,
      });
      
      options.onError?.(errorMessage);
      console.groupEnd();
      throw error;
    }
  }, [options]);

  const reset = useCallback(() => {
    console.log('[useImport] Reset called');
    setState({
      isLoading: false,
      error: null,
      result: null,
    });
  }, []);

  const healthCheck = useCallback(async () => {
    console.log('[useImport] Running health check...');
    return await checkApiHealth();
  }, []);

  return {
    ...state,
    importFile,
    reset,
    healthCheck,
  };
}
