import { createClient } from '@supabase/supabase-js';
import { getConfig } from '../config.js';

const config = getConfig();

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});
