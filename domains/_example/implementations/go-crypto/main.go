// bench hash <bytes>: SHA-256 of <bytes> bytes where byte i = i % 251.
package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"strconv"
)

func main() {
	n, err := strconv.Atoi(os.Args[2])
	if err != nil {
		panic(err)
	}
	pattern := make([]byte, 251*4096)
	for i := range pattern {
		pattern[i] = byte(i % 251)
	}
	h := sha256.New()
	for n > 0 {
		c := min(n, len(pattern))
		h.Write(pattern[:c])
		n -= c
	}
	fmt.Printf("%x\n", h.Sum(nil))
}
