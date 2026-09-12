// Public Supabase config for the customer-facing site (rental request
// inbox only -- the anon key here can only INSERT into rental_requests,
// see supabase/schema.sql for the RLS policies that enforce that).
window.RC_PUBLIC_CONFIG = {
  SUPABASE_URL: 'https://orzlvhyvvvwesibxzlpr.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yemx2aHl2dnZ3ZXNpYnh6bHByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMzcxMTMsImV4cCI6MjEwNDgxMzExM30.m6iyoKJUoSrLFaW518yi2aZzhLlQyKnb1KJh4vCNXx0'
};
