package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"math/rand/v2"
	"net/http"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	qOne    = "SELECT id, randomnumber FROM world WHERE id = $1"
	qUpdate = "UPDATE world SET randomnumber = $1 WHERE id = $2"
	qList   = "SELECT id, randomnumber FROM world WHERE id BETWEEN $1 AND $2 ORDER BY id"
)

type message struct {
	Message string `json:"message"`
}

type world struct {
	ID           int32 `json:"id"`
	RandomNumber int32 `json:"randomNumber"`
}

type listItem struct {
	ID           int32 `json:"id"`
	RandomNumber int32 `json:"randomNumber"`
	IsEven       bool  `json:"isEven"`
}

type orderItem struct {
	Sku       string  `json:"sku"`
	Quantity  int     `json:"quantity"`
	UnitPrice float64 `json:"unitPrice"`
}

type order struct {
	CustomerID int         `json:"customerId"`
	Items      []orderItem `json:"items"`
}

type orderSummary struct {
	CustomerID    int     `json:"customerId"`
	ItemCount     int     `json:"itemCount"`
	TotalQuantity int     `json:"totalQuantity"`
	Total         float64 `json:"total"`
}

func randomID() int32 { return int32(rand.IntN(10000) + 1) }

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func main() {
	pool, err := pgxpool.New(context.Background(), os.Getenv("DB_URL"))
	if err != nil {
		log.Fatal(err)
	}
	one := func(ctx context.Context) (world, error) {
		var wd world
		err := pool.QueryRow(ctx, qOne, randomID()).Scan(&wd.ID, &wd.RandomNumber)
		return wd, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /json", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, message{"Hello, World!"})
	})
	mux.HandleFunc("GET /db", func(w http.ResponseWriter, r *http.Request) {
		wd, err := one(r.Context())
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, wd)
	})
	mux.HandleFunc("GET /queries", func(w http.ResponseWriter, r *http.Request) {
		out := make([]world, 20)
		for i := range out {
			wd, err := one(r.Context())
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			out[i] = wd
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("GET /updates", func(w http.ResponseWriter, r *http.Request) {
		out := make([]world, 5)
		for i := range out {
			wd, err := one(r.Context())
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			wd.RandomNumber = randomID()
			if _, err := pool.Exec(r.Context(), qUpdate, wd.RandomNumber, wd.ID); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			out[i] = wd
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("GET /list", func(w http.ResponseWriter, r *http.Request) {
		start := int32(rand.IntN(9901) + 1)
		rows, err := pool.Query(r.Context(), qList, start, start+99)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer rows.Close()
		out := make([]listItem, 0, 100)
		for rows.Next() {
			var it listItem
			if err := rows.Scan(&it.ID, &it.RandomNumber); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			it.IsEven = it.RandomNumber%2 == 0
			out = append(out, it)
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("POST /orders", func(w http.ResponseWriter, r *http.Request) {
		var o order
		if err := json.NewDecoder(r.Body).Decode(&o); err != nil || len(o.Items) == 0 {
			http.Error(w, "invalid order", 400)
			return
		}
		s := orderSummary{CustomerID: o.CustomerID, ItemCount: len(o.Items)}
		for _, it := range o.Items {
			if it.Quantity < 1 || it.UnitPrice < 0 || it.Sku == "" {
				http.Error(w, "invalid item", 400)
				return
			}
			s.TotalQuantity += it.Quantity
			s.Total += float64(it.Quantity) * it.UnitPrice
		}
		s.Total = math.Round(s.Total*100) / 100
		writeJSON(w, s)
	})
	log.Fatal(http.ListenAndServe(":8080", mux))
}
