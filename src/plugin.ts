import streamDeck from "@elgato/streamdeck";
import { AtisDisplayAction } from "./actions/atis-display";
import { AtisCycleAction } from "./actions/atis-cycle";
import { FlightTrackAction } from "./actions/flight-track";
import { AirportDelayAction } from "./actions/airport-delay";

streamDeck.logger.setLevel("info");

// Register all actions
streamDeck.actions.registerAction(new AtisDisplayAction());
streamDeck.actions.registerAction(new AtisCycleAction());
streamDeck.actions.registerAction(new FlightTrackAction());
streamDeck.actions.registerAction(new AirportDelayAction());

// Connect to Stream Deck
streamDeck.connect();
