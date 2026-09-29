package api

import (
	"crypto/subtle"
	"net/http"
	"regexp"
	"strings"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/httpx"
)

// Roles, weakest first. Reads are open (viewer); consequential actions need a bearer token (brief §18).
const (
	roleViewer = iota
	roleOperator
	roleAdmin
)

var roleNames = []string{"viewer", "operator", "admin"}

type auth struct{ operator, admin string }

func (a auth) enabled() bool { return a.operator != "" || a.admin != "" }

// role maps the request's bearer token to a role. With no tokens configured every caller is admin (dev mode).
func (a auth) role(r *http.Request) int {
	if !a.enabled() {
		return roleAdmin
	}
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	switch {
	case !ok || tok == "":
		return roleViewer
	case a.admin != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(a.admin)) == 1:
		return roleAdmin
	case a.operator != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(a.operator)) == 1:
		return roleOperator
	}
	return roleViewer
}

var actorName = regexp.MustCompile(`^[A-Za-z0-9 ._@-]{1,64}$`)

// actor names who acted, for the decision audit trail: the role, plus an optional self-declared
// X-Actor name (tokens are shared per role, so the name is informational, not authenticated).
func (a auth) actor(r *http.Request) string {
	name := roleNames[a.role(r)]
	if v := strings.TrimSpace(r.Header.Get("X-Actor")); actorName.MatchString(v) {
		name += ":" + v
	}
	return name
}

// require wraps h so only callers with at least role min reach it.
func (a auth) require(min int, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.role(r) < min {
			httpx.WriteJSON(w, http.StatusUnauthorized, apiError{Code: "UNAUTHORIZED",
				Message: "this action needs the " + roleNames[min] + " role: send Authorization: Bearer <token>"})
			return
		}
		h(w, r)
	}
}

func (a auth) me(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"role": roleNames[a.role(r)], "actor": a.actor(r), "auth_enabled": a.enabled()})
}
