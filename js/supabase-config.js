// Supabase project for the shared, live museum. Both values are public by design
// (they ship to every visitor). Never put the service_role / secret key here.
// Remove this file (or blank the values) to run the museum from this browser only.
window.MUSEUM_SUPABASE = {
  url: 'https://xbjkqwlhqzneymtczulk.supabase.co',
  key: 'sb_publishable_ZPNBUAer_EpdX3LIDkcJqg_5z7GXv-A',
  // How many visitors can be in the museum at once (logged-in admins don't count).
  maxVisitors: 10
};
