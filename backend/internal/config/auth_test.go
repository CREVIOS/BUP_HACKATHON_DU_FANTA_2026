package config

import "testing"

func TestRequiredAPIAuth(t *testing.T) {
	for _, tc := range []struct {
		name, required, operator, admin string
		wantError                       bool
	}{
		{"deployment missing both", "true", "", "", true},
		{"deployment missing operator", "true", "", "admin-test", true},
		{"deployment missing admin", "true", "operator-test", "", true},
		{"deployment blank operator", "true", " \n", "admin-test", true},
		{"deployment blank admin", "true", "operator-test", "\t", true},
		{"deployment configured", "true", "operator-test", "admin-test", false},
		{"misspelled flag still requires auth", "ture", "", "", true},
		{"numeric flag still requires auth", "1", "", "", true},
		{"local development", "", "", "", false},
		{"explicit local development", "false", "", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("REQUIRE_AUTH", tc.required)
			t.Setenv("OPERATOR_TOKEN", tc.operator)
			t.Setenv("ADMIN_TOKEN", tc.admin)
			err := Load().ValidateAPIAuth()
			if (err != nil) != tc.wantError {
				t.Fatalf("ValidateAPIAuth() error = %v, wantError = %v", err, tc.wantError)
			}
		})
	}
}
