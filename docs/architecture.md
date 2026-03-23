# Architecture

This page gives a high-level public view of the mesdeparts.ch system.

## Overview

mesdeparts.ch presents public-transport departures through a browser-based experience backed by a service layer and public transport data sources. This page explains the public shape of the system, not the private implementation.

## Main public-facing components

- Browser UI for the live departures experience
- Service/backend layer that serves product data
- Edge or network layer in front of the service
- Upstream transport data sources

## High-level flow

1. A user opens the browser UI.
2. The public-facing service supplies the departure-related data the product needs.
3. The UI presents departures and related information in a user-facing format.
4. The system may use an edge or network layer in front of the service, but the private mechanics are intentionally not documented here.

## What this public repo represents

This repo is the public documentation home for the project. It reflects the public-facing shape of mesdeparts.ch, but it is not the full private production system.

## What is intentionally not documented here

- Proprietary backend logic
- Request-path internals
- Deployment and operational workflows
- Debug surfaces
- Private configuration and secrets
- Exact internal infrastructure details

## Where to go next

- [Docs index](README.md)
- [FAQ](faq.md)
- [Security policy](../SECURITY.md)
- Legacy open-source client: https://github.com/tabbycat18/mesdeparts.ch-legacy
