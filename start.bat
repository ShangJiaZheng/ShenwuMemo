@echo off
start cmd /k "node server.js"
ping -n 3 127.0.0.1 > nul